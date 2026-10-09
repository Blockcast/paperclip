// Ally-gated heavy CI (R1) contract: design ally-gated-ci.md §2, §3.5, §4.2.
//
// Owner directive 2026-10-07 (~01:55Z): "also actively work to reduce and
// isolate CPU waste from CI. CI is suboptimal across the org as you saw in
// this conversation, with jobs running without new signal on each PR, or
// before ally approved resulting in CI runs that are unecessary."
//
// What must hold, and the failure each assertion guards:
//   I1  the hold decides WHEN heavy lanes run, never WHETHER: `verify` keeps
//       `always() && !cancelled()` and needs the hold and every heavy lane;
//   I2  no vacuous pass: the hold never skips (no job-level `if:`), a missing
//       or unreadable verdict holds, and `verify` fails while it holds;
//   I4  release decisions run from trusted default-branch code only: the two
//       jobs holding `actions: write` (the dispatcher's `unlock`, the sweep's
//       `ally_verdict_backstop`) check out the default branch with a
//       SHA-pinned actions/checkout, never name pull request content or move
//       the work tree, write nothing but `actions`, and dispatch at the
//       default branch;
//   I6  exactly once per head: only attempt 1 of the newest run is re-run.
// Plus two availability rules from Ally's review of 2365a502: a PR its own
// reviewer opened is not held while no signal can release it (BLO-34316 makes
// its B neutral and nothing publishes S yet), and the kill switch releases the
// heads it finds already held, not only future pushes. And one from its review
// of 51a85a1ac8: a fork head is not held either, because no release path acts
// on a head outside this repository.
// Node builtins only: `policy` runs this before any install.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  chooseRun,
  liveHeadRefusal,
  pullsForHead,
  rerunDecision,
  selectBackstopCandidates,
} from "../ally-verdict-ci.mjs";
import { decide, preconditionRefusal } from "../../.github/actions/verdict-dispatch/eligible.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const prYml = read(".github/workflows/pr.yml");
const dispatcherYml = read(".github/workflows/dispatch-ally-verdict-ci.yml");
const sweepYml = read(".github/workflows/review-gate-sweep.yml");
const collapse = (text) => String(text).trim().replace(/\s+/g, " ");

// Top-level jobs as raw text blocks, keyed by id.
function jobBlocks(workflow) {
  const body = workflow.slice(workflow.indexOf("\njobs:\n") + 7);
  const blocks = {};
  const re = /^ {2}([A-Za-z0-9_-]+):\n/gm;
  const marks = [...body.matchAll(re)];
  marks.forEach((m, i) => {
    blocks[m[1]] = body.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : body.length);
  });
  return blocks;
}

function needsOf(block) {
  const inline = /^ {4}needs: \[([^\]]*)\]/m.exec(block);
  const multi = /^ {4}needs:\n\s*\[([^\]]*)\]/m.exec(block);
  const list = (inline ?? multi)?.[1] ?? "";
  return list.split(",").map((s) => s.trim()).filter(Boolean);
}

const runsOn = (block) => /^ {4}runs-on: (.+)$/m.exec(block)?.[1] ?? "";
const jobIf = (block) => /^ {4}if: (.+)$/m.exec(block)?.[1];

// The shell of a named step's `run: |` block, de-indented.
function stepScript(block, stepName) {
  const start = block.indexOf(`- name: ${stepName}\n`);
  assert.notEqual(start, -1, `step "${stepName}" not found`);
  const runAt = block.indexOf("run: |\n", start);
  const indent = block.slice(block.lastIndexOf("\n", runAt) + 1, runAt).length + 2;
  const lines = [];
  for (const line of block.slice(runAt + 7).split("\n")) {
    if (line !== "" && !line.startsWith(" ".repeat(indent))) break;
    lines.push(line.slice(indent));
  }
  return lines.join("\n");
}

// A job's steps as raw text, one entry per `- ` item at the steps indent.
function stepsOf(block) {
  const marker = "\n    steps:\n";
  const at = block.indexOf(marker);
  assert.notEqual(at, -1, "job has no `steps:`");
  return block
    .slice(at + marker.length)
    .split(/^ {6}- /m)
    .slice(1)
    .map((step) => `      - ${step}`);
}

const usesOf = (step) => /^(?: {6}- | {8})uses: ([^\s#]+)/m.exec(step)?.[1] ?? null;
const withValue = (step, key) => new RegExp(`^ {10}${key}: (.+)$`, "m").exec(step)?.[1]?.trim();

// Every line that can execute or configure something: comment lines and step
// names dropped, a backslash-newline continuation joined into one command.
const codeOf = (block) =>
  block
    .replace(/\\\r?\n/g, " ")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line) && !/^\s*(?:- )?name:/.test(line))
    .join("\n");

// A job's own `permissions:` map; null when it declares none.
function permissionsOf(block) {
  const at = block.search(/^ {4}permissions:[ \t]*$/m);
  if (at === -1) return null;
  const scopes = {};
  for (const line of block.slice(at).split("\n").slice(1)) {
    if (!line.startsWith("      ")) break;
    const text = line.trim();
    if (text.startsWith("#")) continue;
    const pair = /^([a-z-]+):\s*([a-z-]+)\s*(?:#.*)?$/.exec(text);
    assert.ok(pair, `unreadable permissions line ${JSON.stringify(line)}`);
    scopes[pair[1]] = pair[2];
  }
  return scopes;
}

// A step's GITHUB_OUTPUT, as the runner gives it: a real file, read back into
// `outputs` so what a step hands the next steps is assertable apart from what it
// prints. Never /dev/stdout: on Linux Node hands a child a socketpair for stdio,
// and reopening a socket by path fails with ENXIO (macOS's /dev/fd dups the
// descriptor instead, which is how that passed locally and failed in CI).
function withGithubOutput(run) {
  const dir = mkdtempSync(path.join(tmpdir(), "ally-verdict-gate-"));
  const file = path.join(dir, "github_output");
  const read = () => (existsSync(file) ? readFileSync(file, "utf8") : "");
  try {
    const result = run(file);
    if (typeof result?.then === "function") {
      return result.then((value) => ({ ...value, outputs: read() })).finally(() => rmSync(dir, { recursive: true, force: true }));
    }
    const value = { ...result, outputs: read() };
    rmSync(dir, { recursive: true, force: true });
    return value;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function runBash(script, env) {
  return withGithubOutput((file) =>
    spawnSync("bash", ["-c", script], {
      env: { PATH: process.env.PATH, ...env, GITHUB_OUTPUT: file },
      encoding: "utf8",
    }),
  );
}

const jobs = jobBlocks(prYml);
const HEAVY = [
  "typecheck_release_registry",
  "worktree_install",
  "opencode_responses_replay",
  "opencode_k8s_seed_cold_start",
  "general_tests",
  "build",
  "canary_dry_run",
  "e2e",
];
const LOCAL_ACTION = /uses: \.\/\.github\/actions\/verdict-dispatch\n/g;
const MERGE_QUEUE_OR_LIGHT = "${{ github.event_name == 'merge_group' && 'arc-merge-queue' || 'arc-light' }}";

test("Tier 1 is exactly the jobs on a heavy pool, and every one of them needs the hold", () => {
  const heavyPool = /'(arc-paperclip-general|arc-e2e|arc-default|default|arc-dind|arc-ciab|arc-multicast-integ)'/;
  const onHeavyPool = Object.entries(jobs)
    .filter(([, block]) => heavyPool.test(runsOn(block)))
    .map(([id]) => id)
    .sort();
  assert.deepEqual(onHeavyPool, [...HEAVY].sort(), "a job moved onto (or off) a Tier-1 pool: update HEAVY and its `needs:`");
  for (const id of HEAVY) assert.ok(needsOf(jobs[id]).includes("ally_verdict"), `${id} must need ally_verdict`);
});

test("Tier 0 stays per-push: policy, helm_chart and vendor_claude_k8s do not wait for Ally", () => {
  for (const id of ["policy", "helm_chart", "vendor_claude_k8s"]) {
    assert.ok(jobs[id], `${id} missing`);
    assert.ok(!needsOf(jobs[id]).includes("ally_verdict"), `${id} must stay per-push (design I8)`);
  }
});

test("verify needs the hold, and its `if:` is unchanged (never an attestation `if:`)", () => {
  assert.ok(needsOf(jobs.verify).includes("ally_verdict"));
  assert.equal(jobIf(jobs.verify), "${{ always() && !cancelled() }}");
});

test("the hold job never skips, keeps merge_group off arc-light, and evaluates the vendored predicate", () => {
  const block = jobs.ally_verdict;
  assert.ok(block, "pr.yml must define ally_verdict");
  assert.match(block, /^ {4}name: ally-verdict$/m);
  // BLO-22428: merge_group traffic must not queue behind the pull_request
  // backlog that saturates arc-light; same expression as `policy` and `verify`.
  assert.equal(runsOn(block), MERGE_QUEUE_OR_LIGHT);
  assert.equal(runsOn(jobs.policy), MERGE_QUEUE_OR_LIGHT, "policy's expression moved; keep the hold on the same one");
  assert.equal(jobIf(block), undefined, "a job-level `if:` would skip the hold, and a skipped need passes (I2)");
  assert.doesNotMatch(block, /continue-on-error/, "an evaluation error must hold the lanes, not pass");
  assert.equal([...block.matchAll(LOCAL_ACTION)].length, 1);
  assert.match(block, /sparse-checkout: \.github\/actions\/verdict-dispatch\n/);
  assert.match(block, /head-sha: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(block, /bypass: \$\{\{ vars\.ALLY_GATED_CI_BYPASS \}\}/);
  assert.match(block, /PR_AUTHOR: \$\{\{ github\.event\.pull_request\.user\.login \}\}/);
  assert.match(block, /HOLD_SELF_AUTHORED: \$\{\{ vars\.ALLY_GATED_CI_HOLD_SELF_AUTHORED \}\}/);
  assert.match(block, /HEAD_REPO: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}\n/);
  assert.match(block, /REPOSITORY: \$\{\{ github\.repository \}\}\n/);
  assert.match(block, /RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
});

const MODE_STEP = "Decide whether this run waits for an Ally verdict";

test("mode step: merge_group and the bypass release at once; a pull_request is evaluated; anything else holds", () => {
  const script = stepScript(jobs.ally_verdict, MODE_STEP);
  const pr = { EVENT_NAME: "pull_request", PR_AUTHOR: "kkroo" };
  const cases = [
    [{ EVENT_NAME: "merge_group" }, 0, "evaluate=false"],
    [{ ...pr, BYPASS: "true" }, 0, "evaluate=false"],
    [{ ...pr, BYPASS: "TRUE" }, 0, "evaluate=false"],
    [{ ...pr, BYPASS: "" }, 0, "evaluate=true"],
    [{ ...pr, BYPASS: "false" }, 0, "evaluate=true"],
    [{ ...pr, BYPASS: "yes" }, 0, "evaluate=true"],
    [{ ...pr, BYPASS: " true" }, 0, "evaluate=true"],
    [{ EVENT_NAME: "push" }, 1, null],
  ];
  for (const [env, status, output] of cases) {
    const result = runBash(script, env);
    assert.equal(result.status, status, JSON.stringify(env) + result.stdout + result.stderr);
    // Exactly what the next steps read: one `evaluate=` line, or nothing when it holds outright.
    assert.equal(result.outputs, output === null ? "" : `${output}\n`, JSON.stringify(env) + result.stderr);
  }
});

// BLO-34316: the server withholds B's `clean` whenever the PR author shares the
// reviewer identity (githubSharesReviewerIdentity: the `allyblockcast` seat,
// `allyblockcast[bot]` or `app/allyblockcast`, compared lowercased), so B is
// never `success` on such a PR, and S (ci/ally-head-attested) has no producer
// yet. Holding those PRs would hold them for good.
const SELF_AUTHORED = ["allyblockcast[bot]", "allyblockcast", "app/allyblockcast", "AllyBlockcast[bot]", "ALLYBLOCKCAST"];
const NOT_SELF_AUTHORED = ["kkroo", "allyblockcast-bot", "xallyblockcast", "allyblockcast[bot]x", "app/allyblockcastx", "dependabot[bot]", ""];

test("mode step: a PR its own reviewer opened runs heavy CI per push until the owner opts it in", () => {
  const script = stepScript(jobs.ally_verdict, MODE_STEP);
  for (const author of SELF_AUTHORED) {
    for (const hold of ["", "false", "yes", " true"]) {
      const result = runBash(script, { EVENT_NAME: "pull_request", PR_AUTHOR: author, HOLD_SELF_AUTHORED: hold });
      assert.equal(result.status, 0, `${author}/${hold}: ${result.stdout}${result.stderr}`);
      assert.equal(result.outputs, "evaluate=false\n", `${author} with HOLD_SELF_AUTHORED=${JSON.stringify(hold)} must not be held`);
      assert.match(result.stdout, /::notice title=ally-verdict: self-authored PR::/);
    }
    for (const hold of ["true", "TRUE", "True"]) {
      const result = runBash(script, { EVENT_NAME: "pull_request", PR_AUTHOR: author, HOLD_SELF_AUTHORED: hold });
      assert.equal(result.outputs, "evaluate=true\n", `${author}: the owner opted self-authored PRs in`);
    }
  }
  for (const author of NOT_SELF_AUTHORED) {
    const result = runBash(script, { EVENT_NAME: "pull_request", PR_AUTHOR: author, HOLD_SELF_AUTHORED: "" });
    assert.equal(result.status, 0);
    assert.equal(result.outputs, "evaluate=true\n", `${JSON.stringify(author)} is not the reviewer identity: gated`);
  }
});

// Ally's review of 51a85a1ac8: the shared predicate refuses a head outside this
// repository, and both release paths skip one before deciding (pullsForHead,
// selectBackstopCandidates), so a held fork head would be held for good while
// its annotation promised an automatic release. Same shape as the self-authored
// case, same answer: not held.
test("mode step: a fork head is not held, because no release path acts on one", () => {
  const script = stepScript(jobs.ally_verdict, MODE_STEP);
  const base = { EVENT_NAME: "pull_request", PR_AUTHOR: "kkroo", REPOSITORY: "Blockcast/paperclip" };
  // A deleted fork reads as an empty head repository: still not this one.
  for (const headRepo of ["someone/paperclip", "paperclipai/paperclip", "Blockcast/paperclip-fork", ""]) {
    const result = runBash(script, { ...base, HEAD_REPO: headRepo });
    assert.equal(result.status, 0, `${headRepo}: ${result.stdout}${result.stderr}`);
    assert.equal(result.outputs, "evaluate=false\n", `${JSON.stringify(headRepo)} is not this repository: never held`);
    assert.match(result.stdout, /::notice title=ally-verdict: fork PR::/);
  }
  for (const headRepo of ["Blockcast/paperclip", "blockcast/PAPERCLIP"]) {
    const result = runBash(script, { ...base, HEAD_REPO: headRepo });
    assert.equal(result.outputs, "evaluate=true\n", `${headRepo} is this repository: gated`);
    assert.doesNotMatch(result.stdout, /fork PR/);
  }
  // The bypass and the merge queue still decide first.
  assert.equal(runBash(script, { ...base, HEAD_REPO: "someone/paperclip", BYPASS: "true" }).outputs, "evaluate=false\n");
  assert.doesNotMatch(runBash(script, { ...base, HEAD_REPO: "someone/paperclip", BYPASS: "true" }).stdout, /fork PR/);
});

test("the exempt identity is the reviewer the server withholds B for (BLO-34316)", () => {
  // If the server's default reviewer moves, the identity whose PRs can never
  // reach B `success` moves with it, and the mode step's case list must follow.
  assert.match(read("server/src/services/pr-comment-review-gate.ts"), /^const DEFAULT_PR_REVIEWER_BOT_LOGIN = "allyblockcast\[bot\]";$/m);
  const script = stepScript(jobs.ally_verdict, MODE_STEP);
  assert.match(script, /allyblockcast\|allyblockcast\\\[bot\\\]\|app\/allyblockcast\)/);
});

const HOLD_STEP = "Hold heavy lanes until Ally's verdict";

test("hold step: only eligible=true releases; not eligible, an error, or a missing output holds with the annotation", () => {
  const script = stepScript(jobs.ally_verdict, HOLD_STEP);
  const head = "a".repeat(40);
  assert.equal(runBash(script, { ELIGIBLE: "true", BASIS: "head-attested", HEAD_SHA: head, RUN_ATTEMPT: "1" }).status, 0);
  for (const env of [
    // B neutral and no S yet: the predicate answers not eligible (fail closed).
    { ELIGIBLE: "false", REASON: "no positive Ally signal: ci/ally-head-attested=absent" },
    { ELIGIBLE: "false", REASON: "error: GitHub API 502" },
    { ELIGIBLE: "" },
    { ELIGIBLE: "TRUE" },
  ]) {
    const result = runBash(script, { ...env, HEAD_SHA: head, RUN_ATTEMPT: "1" });
    assert.equal(result.status, 1, JSON.stringify(env));
    // The release is conditional on a clean verdict; the annotation says so
    // instead of promising a rerun unconditionally.
    assert.match(
      result.stdout,
      /::error title=awaiting-ally-verdict::Heavy CI waits for a clean Ally verdict at a{40} \(gate\/ally-comment-findings or ci\/ally-head-attested success\); it then reruns automatically\./,
    );
  }
});

test("hold step: a run re-run by hand no longer promises the automatic release", () => {
  const script = stepScript(jobs.ally_verdict, HOLD_STEP);
  for (const attempt of ["2", "3", ""]) {
    const result = runBash(script, { ELIGIBLE: "false", REASON: "x", HEAD_SHA: "a".repeat(40), RUN_ATTEMPT: attempt });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error title=awaiting-ally-verdict::/);
    assert.doesNotMatch(result.stdout, /reruns automatically/, `attempt ${JSON.stringify(attempt)}`);
    assert.match(result.stdout, /re-run its failed jobs by hand/);
  }
});

const laneEnv = (overrides) => ({
  INFRA_LANES: "",
  HELM_CHART_RESULT: "success",
  TYPECHECK_RELEASE_REGISTRY_RESULT: "success",
  GENERAL_TESTS_RESULT: "success",
  WORKTREE_INSTALL_RESULT: "success",
  OPENCODE_RESPONSES_REPLAY_RESULT: "success",
  OPENCODE_K8S_SEED_COLD_START_RESULT: "success",
  BUILD_RESULT: "success",
  VENDOR_CLAUDE_K8S_RESULT: "success",
  ALLY_VERDICT_RESULT: "success",
  RUN_ATTEMPT: "1",
  ...overrides,
});
const held = {
  ALLY_VERDICT_RESULT: "failure",
  TYPECHECK_RELEASE_REGISTRY_RESULT: "skipped",
  GENERAL_TESTS_RESULT: "skipped",
  WORKTREE_INSTALL_RESULT: "skipped",
  OPENCODE_RESPONSES_REPLAY_RESULT: "skipped",
  OPENCODE_K8S_SEED_COLD_START_RESULT: "skipped",
  BUILD_RESULT: "skipped",
};
const VERIFY_STEP = "Fail if any split verify lane failed";

test("verify fails red (not skipped) while the hold holds, and says it is a schedule state", () => {
  const script = stepScript(jobs.verify, VERIFY_STEP);
  const result = runBash(script, laneEnv(held));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error title=verify: awaiting-ally-verdict::/);
  assert.match(result.stdout, /deferred: typecheck_release_registry general_tests/);
  assert.match(result.stdout, /re-runs this run's failed jobs automatically/);
  assert.doesNotMatch(result.stdout, /title=verify: lane skipped/);
  for (const value of ["skipped", "cancelled", ""]) {
    assert.equal(runBash(script, laneEnv({ ...held, ALLY_VERDICT_RESULT: value })).status, 1, `ally_verdict=${value}`);
  }
  const helmToo = runBash(script, laneEnv({ ...held, HELM_CHART_RESULT: "failure" }));
  assert.equal(helmToo.status, 1);
  assert.match(helmToo.stdout, /title=verify: lane failure::.*helm_chart/, "a Tier-0 failure is still reported under the hold");
  assert.equal(runBash(script, laneEnv({})).status, 0, "released and all green passes");
  assert.match(jobs.verify, /RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
});

test("verify under a hold on a hand re-run says to re-run by hand, not that it reruns automatically", () => {
  const script = stepScript(jobs.verify, VERIFY_STEP);
  const result = runBash(script, laneEnv({ ...held, RUN_ATTEMPT: "2" }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error title=verify: awaiting-ally-verdict::/);
  assert.doesNotMatch(result.stdout, /re-runs this run's failed jobs automatically/, "the release re-runs attempt 1 only");
  assert.match(result.stdout, /attempt 2, re-run by hand/);
  assert.match(result.stdout, /re-run its failed jobs by hand/);
});

test("the wording-only classifier is not spent on a held run", () => {
  const ifs = jobs.verify.match(/if: \$\{\{ contains\(needs\.\*\.result, 'failure'\)[^\n]*/g);
  assert.equal(ifs.length, 3);
  for (const line of ifs) assert.match(line, /&& needs\.ally_verdict\.result != 'failure' \}\}$/);
});

// --- trusted code only (I4), for both jobs that hold `actions: write` -----------

// Ported from Blockcast/review-gate-action 7e3259a (main; #25's merge commit) scripts/verify-consumer-wiring.mjs
// (PULL_CONTENT_REF, WORKTREE_GIT_VERB), which closed the same denylist gap
// there: a `git fetch refs/pull/N/head; git reset --hard FETCH_HEAD` step
// would run pull request code under `actions: write`.
const PULL_CONTENT_REF = /refs\/pull\/|\bFETCH_HEAD\b|refs\/verdict-dispatch\//;
const WORKTREE_GIT_VERB =
  /\bgit\b[^\n;&|]*?(?<![\w-])(?:checkout|switch|worktree|reset|restore|read-tree|pull|merge|cherry-pick|apply|am|rebase|stash|revert|clean)(?![\w-])|\bgh\s+pr\s+checkout\b/;
const PINNED = /^actions\/(checkout|setup-node)@[0-9a-f]{40}$/;
const DEFAULT_BRANCH = "${{ github.event.repository.default_branch }}";

const writeScopedJobs = () => [
  ["dispatch-ally-verdict-ci.yml unlock", jobBlocks(dispatcherYml).unlock, { localAction: true }],
  ["review-gate-sweep.yml ally_verdict_backstop", jobBlocks(sweepYml).ally_verdict_backstop, { localAction: false }],
];

function trustedCodeProblems(block, { localAction }) {
  const problems = [];
  const code = codeOf(block);
  if (PULL_CONTENT_REF.test(code)) problems.push("names pull request content (refs/pull/, FETCH_HEAD or refs/verdict-dispatch/)");
  if (WORKTREE_GIT_VERB.test(code)) problems.push("moves the work tree off the default branch (git checkout/reset/fetch-and-switch or gh pr checkout)");
  if (/carry-forward:/.test(code)) problems.push("enables carry-forward, which fetches the PR head into this checkout");
  const scopes = permissionsOf(block);
  if (scopes === null) {
    problems.push("declares no `permissions:`, so it inherits a wider token");
  } else {
    const writes = Object.entries(scopes).filter(([, level]) => !["read", "none"].includes(level));
    if (JSON.stringify(writes) !== JSON.stringify([["actions", "write"]])) {
      problems.push(`may write only \`actions\`; got ${JSON.stringify(writes)}`);
    }
  }
  let checkouts = 0;
  for (const step of stepsOf(block)) {
    const uses = usesOf(step);
    if (uses === null) continue;
    if (uses === "./.github/actions/verdict-dispatch" && localAction) continue;
    if (!PINNED.test(uses)) {
      problems.push(`uses ${uses}; only SHA-pinned actions/checkout and actions/setup-node${localAction ? " and the vendored predicate" : ""} are allowed`);
      continue;
    }
    if (uses.startsWith("actions/checkout@")) {
      checkouts += 1;
      if (withValue(step, "ref") !== DEFAULT_BRANCH) problems.push(`checks out ${withValue(step, "ref") ?? "the triggering ref"}, not ${DEFAULT_BRANCH}`);
      if (withValue(step, "repository") !== undefined) problems.push("checks out another repository");
      if (withValue(step, "persist-credentials") !== "false") problems.push("persists the write token into the checkout");
    }
  }
  if (checkouts !== 1) problems.push(`has ${checkouts} checkouts; exactly one, of the default branch`);
  return problems;
}

test("I4: both write-scoped jobs run default-branch code only and write nothing but actions", () => {
  for (const [label, block, options] of writeScopedJobs()) {
    assert.ok(block, `${label} missing`);
    assert.deepEqual(trustedCodeProblems(block, options), [], label);
  }
});

test("I4 guard: it rejects the shapes that would run pull request code under actions: write", () => {
  const [[, unlock], [, backstop]] = writeScopedJobs();
  const stepAt = (block, marker, text) => block.replace(marker, `${text}${marker}`);
  const setupNode = "      - name: Set up Node\n";
  const mutations = [
    [unlock, { localAction: true }, stepAt(unlock, setupNode, "      - name: fetch\n        run: git fetch origin refs/pull/7/head && git reset --hard FETCH_HEAD\n")],
    [unlock, { localAction: true }, stepAt(unlock, setupNode, "      - run: |\n          git -C . switch --detach \\\n            \"$SHA\"\n")],
    [unlock, { localAction: true }, unlock.replace(DEFAULT_BRANCH, "${{ github.event.check_run.head_sha }}")],
    [unlock, { localAction: true }, unlock.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v6")],
    [unlock, { localAction: true }, unlock.replace("persist-credentials: false", "persist-credentials: true")],
    [unlock, { localAction: true }, unlock.replace("      checks: read\n", "      checks: write\n")],
    [unlock, { localAction: true }, unlock.replace("bypass: ${{ vars.ALLY_GATED_CI_BYPASS }}", "bypass: ${{ vars.ALLY_GATED_CI_BYPASS }}\n          carry-forward: true")],
    [backstop, { localAction: false }, stepAt(backstop, setupNode, "      - name: pr\n        run: gh pr checkout 1\n")],
    [backstop, { localAction: false }, backstop.replace(/^ {4}permissions:\n(?: {6}.*\n)+/m, "")],
    [backstop, { localAction: false }, stepAt(backstop, setupNode, "      - uses: ./.github/actions/verdict-dispatch\n")],
    [backstop, { localAction: false }, backstop.replace(/\n {10}ref: [^\n]+/, "")],
  ];
  for (const [original, options, mutated] of mutations) {
    assert.notEqual(mutated, original, "mutation did not apply");
    assert.notDeepEqual(trustedCodeProblems(mutated, options), [], mutated);
  }
});

test("the backstop's workflow runs only on its schedule and by hand, never on a pull request event", () => {
  const on = sweepYml.slice(sweepYml.indexOf("\non:\n"), sweepYml.indexOf("\npermissions:"));
  assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]), ["schedule", "workflow_dispatch"]);
});

// --- dispatcher ---------------------------------------------------------------

const CANONICAL =
  "(github.event_name == 'check_run' && github.event.check_run.app.id == 3966421 && " +
  "github.event.check_run.conclusion == 'success' && (github.event.check_run.name == " +
  "'gate/ally-comment-findings' || github.event.check_run.name == 'ci/ally-head-attested')) || " +
  "(github.event_name == 'workflow_dispatch')";

test("dispatcher: only the verdict and manual arms, each a trusted default-branch trigger", () => {
  const on = dispatcherYml.slice(dispatcherYml.indexOf("\non:\n"), dispatcherYml.indexOf("\npermissions:"));
  assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]), ["check_run", "workflow_dispatch"]);
  assert.match(on, /check_run:\n {4}types: \[completed\]\n/);
  assert.match(on, /workflow_dispatch:\n {4}inputs:\n {6}pr_number:\n/);
  assert.doesNotMatch(dispatcherYml, /^ {2}(pull_request|pull_request_target|pull_request_review)\b/m);
});

test("dispatcher: one job, the canonical filter (built from the predicate's constants), arc-light, default branch", () => {
  const dj = jobBlocks(dispatcherYml);
  assert.deepEqual(Object.keys(dj), ["unlock"]);
  const block = dj.unlock;
  const ifText = /^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(block)?.[1];
  assert.equal(collapse(ifText), CANONICAL);
  assert.equal(runsOn(block), "arc-light");
  assert.match(block, /uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n {8}with:\n {10}ref: \$\{\{ github\.event\.repository\.default_branch \}\}\n/);
  assert.match(block, /concurrency:\n {6}group: ally-verdict-dispatch-\$\{\{[^\n]*\}\}\n {6}cancel-in-progress: false\n/);
  assert.match(block, /bypass: \$\{\{ vars\.ALLY_GATED_CI_BYPASS \}\}/);
  assert.match(block, /actions: write/);
});

// `inputs` is empty on the check_run (verdict) arm, so a pull number taken from
// it alone makes the predicate exit non-zero there and heavy CI never starts on
// a verdict (review-gate-action #25 made its checker reject that shape, at
// 7e3259a). The resolve step derives it per arm instead: from the check_run's
// head on the verdict arm, from the validated input on the manual arm.
test("dispatcher: the pull number comes from the resolve step on every arm, never from inputs alone", () => {
  const steps = stepsOf(jobBlocks(dispatcherYml).unlock);
  const isResolve = (step) => /^ {8}id: resolve$/m.test(step);
  const resolveStep = steps.find(isResolve);
  assert.ok(resolveStep, "the dispatcher must resolve the PR in its own step");
  assert.match(resolveStep, /run: node scripts\/ally-verdict-ci\.mjs resolve\n/);
  assert.match(resolveStep, /EVENT_NAME: \$\{\{ github\.event_name \}\}\n/);
  assert.match(resolveStep, /CHECK_HEAD_SHA: \$\{\{ github\.event\.check_run\.head_sha \}\}\n/);
  assert.match(resolveStep, /INPUT_PR_NUMBER: \$\{\{ inputs\.pr_number \}\}\n/);
  const evaluate = steps.filter((step) => usesOf(step) === "./.github/actions/verdict-dispatch");
  assert.equal(evaluate.length, 1);
  assert.equal(withValue(evaluate[0], "pull-number"), "${{ steps.resolve.outputs.pr_number }}");
  assert.equal(withValue(evaluate[0], "head-sha"), "${{ steps.resolve.outputs.head_sha }}");
  const unlockStep = steps.find((step) => /run: node scripts\/ally-verdict-ci\.mjs unlock\n/.test(step));
  assert.ok(unlockStep);
  assert.match(unlockStep, /PR_NUMBER: \$\{\{ steps\.resolve\.outputs\.pr_number \}\}\n/);
  assert.match(unlockStep, /HEAD_SHA: \$\{\{ steps\.resolve\.outputs\.head_sha \}\}\n/);
  for (const step of steps.filter((s) => !isResolve(s))) {
    assert.doesNotMatch(codeOf(step), /\binputs\./, `only the resolve step may read inputs:\n${step}`);
  }
});

test("the hold and the release evaluate one predicate, byte-identical to the pinned upstream commit", () => {
  assert.equal([...prYml.matchAll(LOCAL_ACTION)].length, 1);
  assert.equal([...dispatcherYml.matchAll(LOCAL_ACTION)].length, 1);
  assert.doesNotMatch(prYml + dispatcherYml, /Blockcast\/review-gate-action\/verdict-dispatch@/, "private action: unresolvable from this public repo");
  // PROVENANCE.json: carry-forward stays off with this copy.
  assert.doesNotMatch(prYml + dispatcherYml, /carry-forward:/);
  const provenance = JSON.parse(read(".github/actions/verdict-dispatch/PROVENANCE.json"));
  assert.equal(provenance.source_repository, "Blockcast/review-gate-action");
  assert.match(provenance.source_commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(provenance.files).sort(), ["action.yml", "eligible.mjs"]);
  for (const [name, { git_blob: blob }] of Object.entries(provenance.files)) {
    const bytes = readFileSync(path.join(root, ".github/actions/verdict-dispatch", name));
    const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    assert.equal(actual, blob, `${name} drifted from ${provenance.source_commit}; re-vendor it, never hand-edit`);
  }
});

test("the vendored predicate fails closed on a missing S, and S never clears a blocking B", () => {
  const absent = { state: "absent", id: null };
  const sig = (state, id) => ({ state, id });
  // A PR the reviewer did not open, B neutral (not yet reviewed), no S: held.
  assert.equal(decide({ allyComplete: absent, commentFindings: sig("neutral", 1), headAttested: absent }).eligible, false);
  assert.equal(decide({ allyComplete: absent, commentFindings: absent, headAttested: absent }).eligible, false);
  assert.equal(decide({ allyComplete: absent, commentFindings: sig("neutral", 1), headAttested: sig("success", 2) }).basis, "head-attested");
  assert.equal(decide({ allyComplete: absent, commentFindings: sig("success", 1), headAttested: absent }).basis, "comment-findings-clean");
  assert.equal(decide({ allyComplete: absent, commentFindings: sig("failure", 1), headAttested: sig("success", 2) }).eligible, false);
  const pull = { number: 1, state: "open", draft: true, head: { sha: "d".repeat(40), repo: { full_name: "Blockcast/paperclip" } } };
  assert.match(preconditionRefusal(pull, { repository: "Blockcast/paperclip", headSha: "d".repeat(40) }), /draft/);
});

test("backstop: its own arc-light job in the sweep, with its own write scope and the kill switch", () => {
  const block = jobBlocks(sweepYml).ally_verdict_backstop;
  assert.ok(block);
  assert.equal(runsOn(block), "arc-light");
  assert.match(block, /permissions:\n(?: {6}.*\n)*? {6}actions: write\n/);
  assert.match(block, /run: node scripts\/ally-verdict-ci\.mjs backstop/);
  assert.match(block, /ALLY_GATED_CI_BYPASS: \$\{\{ vars\.ALLY_GATED_CI_BYPASS \}\}/, "the bypass must reach heads already held");
  // A key line, not prose: the backstop's own comment names the scope.
  assert.doesNotMatch(jobBlocks(sweepYml).sweep, /^ {6}actions: write$/m, "the status-free sweep keeps its narrower scope");
});

// --- pure decisions -------------------------------------------------------------

const H = "b".repeat(40);
const REPO = "Blockcast/paperclip";
const run = (over) => ({
  id: 10,
  event: "pull_request",
  head_sha: H,
  head_branch: "feat",
  head_repository: { full_name: REPO },
  status: "completed",
  run_attempt: 1,
  ...over,
});
const lock = (conclusion) => [{ name: "ally-verdict", conclusion }, { name: "verify", conclusion: "failure" }];

test("rerunDecision: exactly once, only attempt 1 of a completed run whose hold failed", () => {
  assert.equal(rerunDecision(run(), lock("failure")).rerun, true);
  assert.equal(rerunDecision(null, []).rerun, false);
  assert.equal(rerunDecision(run({ status: "in_progress" }), lock("failure")).rerun, false);
  assert.equal(rerunDecision(run({ status: "queued" }), lock("failure")).rerun, false);
  assert.equal(rerunDecision(run({ run_attempt: 2 }), lock("failure")).rerun, false, "I6: never a second automatic re-run");
  assert.match(rerunDecision(run(), lock("success")).reason, /covered/);
  for (const c of ["cancelled", "skipped", null]) assert.equal(rerunDecision(run(), lock(c)).rerun, false);
  assert.equal(rerunDecision(run(), []).rerun, false);
  assert.equal(rerunDecision(run(), [...lock("failure"), { name: "ally-verdict", conclusion: "failure" }]).rerun, false);
});

test("chooseRun: newest pull_request run by id on this PR's branch at this head", () => {
  const runs = [run({ id: 5 }), run({ id: 9 }), run({ id: 12, head_branch: "other" }), run({ id: 13, event: "merge_group" }), run({ id: 14, head_sha: "c".repeat(40) }), run({ id: 15, head_repository: { full_name: "fork/paperclip" } })];
  assert.equal(chooseRun(runs, { headSha: H, headRef: "feat", repository: REPO }).id, 9);
  assert.equal(chooseRun([], { headSha: H, headRef: "feat", repository: REPO }), null);
});

test("liveHeadRefusal and pullsForHead: only open, same-repo PRs whose live head is the evaluated head", () => {
  const pull = { number: 7, state: "open", head: { sha: H, ref: "feat", repo: { full_name: REPO } }, base: { ref: "master" } };
  assert.equal(liveHeadRefusal(pull, { headSha: H, repository: REPO }), null);
  assert.match(liveHeadRefusal({ ...pull, head: { ...pull.head, sha: "c".repeat(40) } }, { headSha: H, repository: REPO }), /head moved/);
  assert.match(liveHeadRefusal({ ...pull, state: "closed" }, { headSha: H, repository: REPO }), /not open/);
  assert.match(liveHeadRefusal({ ...pull, head: { ...pull.head, repo: { full_name: "x/y" } } }, { headSha: H, repository: REPO }), /not in/);
  const other = { ...pull, number: 3 };
  const fork = { ...pull, number: 2, head: { ...pull.head, repo: { full_name: "x/paperclip" } } };
  const closed = { ...pull, number: 1, state: "closed" };
  const otherBase = { ...pull, number: 4, base: { ref: "release" } };
  assert.deepEqual(pullsForHead([pull, other, fork, closed, otherBase], { headSha: H, repository: REPO, baseRef: "master" }), [3, 7]);
});

const prNode = (over = {}, { ally = [], locks = [{ databaseId: 1, conclusion: "FAILURE" }], suite = {}, base = "master" } = {}) => ({
  number: 1,
  isDraft: false,
  baseRefName: base,
  headRefOid: H,
  headRepository: { nameWithOwner: REPO },
  commits: { nodes: [{ commit: { oid: H, ally: { nodes: [{ checkRuns: { nodes: ally } }] }, actions: { nodes: [{ workflowRun: { databaseId: 50, event: "pull_request", workflow: { name: "PR" } }, checkRuns: { nodes: locks }, ...suite }] } } }] },
  ...over,
});
const B = (id, conclusion) => ({ databaseId: id, name: "gate/ally-comment-findings", conclusion });
const S = (id, conclusion) => ({ databaseId: id, name: "ci/ally-head-attested", conclusion });
const repoNode = (...prs) => ({ defaultBranchRef: { name: "master" }, pullRequests: { nodes: prs } });

test("backstop pre-filter: a held attempt-1 head with B or S success; a missing S never admits", () => {
  const pick = (...prs) => selectBackstopCandidates(repoNode(...prs), REPO);
  assert.deepEqual(pick(prNode({}, { ally: [B(1, "SUCCESS")] })), [1]);
  assert.deepEqual(pick(prNode({}, { ally: [B(1, "NEUTRAL"), S(2, "SUCCESS")] })), [1]);
  assert.deepEqual(pick(prNode({}, { ally: [B(1, "NEUTRAL")] })), [], "B neutral and S absent: fail closed");
  assert.deepEqual(pick(prNode({}, { ally: [] })), []);
  assert.deepEqual(pick(prNode({}, { ally: [B(1, "SUCCESS"), B(2, "FAILURE")] })), [], "newest B blocks");
  assert.deepEqual(pick(prNode({}, { ally: [B(2, "SUCCESS"), B(1, "FAILURE")] })), [1], "newest by id, never any-success");
  assert.deepEqual(pick(prNode({}, { ally: [B(9, "FAILURE"), S(10, "SUCCESS")] })), [], "S never clears a blocking B");
  assert.deepEqual(pick(prNode({ isDraft: true }, { ally: [B(1, "SUCCESS")] })), []);
  assert.deepEqual(pick(prNode({ headRepository: { nameWithOwner: "x/paperclip" } }, { ally: [B(1, "SUCCESS")] })), []);
  assert.deepEqual(pick(prNode({ baseRefName: "release" }, { ally: [B(1, "SUCCESS")] })), []);
  assert.deepEqual(pick(prNode({ headRefOid: "c".repeat(40) }, { ally: [B(1, "SUCCESS")] })), []);
  const attempt2 = { locks: [{ databaseId: 1, conclusion: "FAILURE" }, { databaseId: 2, conclusion: "FAILURE" }] };
  assert.deepEqual(pick(prNode({}, { ally: [B(1, "SUCCESS")], ...attempt2 })), [], "attempt 2 needs a human");
  assert.deepEqual(pick(prNode({}, { ally: [B(1, "SUCCESS")], locks: [{ databaseId: 1, conclusion: "SUCCESS" }] })), []);
  assert.deepEqual(pick(prNode({}, { ally: [B(1, "SUCCESS")], suite: { workflowRun: { databaseId: 50, event: "pull_request", workflow: { name: "E2E" } } } })), []);
});

test("backstop pre-filter under ALLY_GATED_CI_BYPASS: every held attempt-1 head, whatever B and S say", () => {
  const pick = (...prs) => selectBackstopCandidates(repoNode(...prs), REPO, { bypass: true });
  // The predicate under bypass ignores the signals, so the pre-filter must too:
  // the heads held before the switch was thrown are exactly these.
  assert.deepEqual(pick(prNode({}, { ally: [B(1, "NEUTRAL")] })), [1], "self-attested B neutral, no S");
  assert.deepEqual(pick(prNode({}, { ally: [] })), [1], "no Ally signal at all");
  assert.deepEqual(pick(prNode({}, { ally: [B(1, "FAILURE")] })), [1], "pre-gating behaviour: heavy CI per push");
  // The preconditions still apply, as in the predicate.
  assert.deepEqual(pick(prNode({ isDraft: true })), []);
  assert.deepEqual(pick(prNode({ headRepository: { nameWithOwner: "x/paperclip" } })), []);
  assert.deepEqual(pick(prNode({ baseRefName: "release" })), []);
  assert.deepEqual(pick(prNode({ headRefOid: "c".repeat(40) })), []);
  // And only a held attempt 1, which is all the dispatcher re-runs.
  assert.deepEqual(pick(prNode({}, { locks: [{ databaseId: 1, conclusion: "SUCCESS" }] })), []);
  assert.deepEqual(pick(prNode({}, { locks: [{ databaseId: 1, conclusion: "FAILURE" }, { databaseId: 2, conclusion: "FAILURE" }] })), []);
  assert.deepEqual(selectBackstopCandidates(repoNode(prNode({}, { ally: [B(1, "NEUTRAL")] })), REPO, { bypass: false }), []);
});

// --- the scripts end to end, against a local fake of the GitHub API -------------

async function scriptAgainst(mode, routes, env) {
  const calls = [];
  const bodies = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      calls.push(`${req.method} ${req.url}`);
      bodies.push({ call: `${req.method} ${req.url}`, body: raw === "" ? null : JSON.parse(raw) });
      const route = routes.find(([method, re]) => method === req.method && re.test(req.url));
      const [status, body] = route ? route[2](calls) : [404, { message: "no route" }];
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === null ? "" : JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const child = spawn(process.execPath, [path.join(root, "scripts/ally-verdict-ci.mjs"), mode], {
    env: {
      PATH: process.env.PATH,
      GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
      GITHUB_TOKEN: "t",
      GITHUB_REPOSITORY: REPO,
      ...env,
    },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  const status = await new Promise((resolve) => child.on("close", resolve));
  server.close();
  return { status, stdout, calls, bodies };
}

const unlockAgainst = (routes, env) =>
  scriptAgainst("unlock", routes, { PR_NUMBER: "7", HEAD_SHA: H, ELIGIBLE: "true", BASIS: "comment-findings-clean", ...env });

const livePull = (sha = H) => ({ number: 7, state: "open", head: { sha, ref: "feat", repo: { full_name: REPO } }, base: { ref: "master" } });
const baseRoutes = (pulls) => [
  ["GET", /^\/repos\/Blockcast\/paperclip\/pulls\/7$/, (calls) => [200, pulls[Math.min(calls.filter((c) => c.endsWith("/pulls/7")).length, pulls.length) - 1]]],
  ["GET", /\/actions\/workflows\/pr\.yml\/runs\?head_sha=b{40}&event=pull_request/, () => [200, { workflow_runs: [run({ id: 77 })] }]],
  ["GET", /\/actions\/runs\/77\/jobs\?filter=latest/, () => [200, { jobs: lock("failure") }]],
  ["POST", /\/actions\/runs\/77\/rerun-failed-jobs$/, () => [201, null]],
];

test("unlock re-runs the held run's failed jobs once, after re-reading the head", async () => {
  const { status, stdout, calls } = await unlockAgainst(baseRoutes([livePull(), livePull()]), {});
  assert.equal(status, 0, stdout);
  assert.match(stdout, /UNLOCKED/);
  assert.deepEqual(calls.filter((c) => c.startsWith("POST")), ["POST /repos/Blockcast/paperclip/actions/runs/77/rerun-failed-jobs"]);
  assert.equal(calls.filter((c) => c.endsWith("/pulls/7")).length, 2, "the head is re-read immediately before the write");
});

test("unlock writes nothing when the head moves between the decision and the write", async () => {
  const { status, stdout, calls } = await unlockAgainst(baseRoutes([livePull(), livePull("c".repeat(40))]), {});
  assert.equal(status, 0, stdout);
  assert.match(stdout, /STOP before re-run, head moved/);
  assert.equal(calls.filter((c) => c.startsWith("POST")).length, 0);
});

test("unlock reads nothing and writes nothing when the head is not eligible (fail closed)", async () => {
  const { status, stdout, calls } = await unlockAgainst(baseRoutes([livePull()]), { ELIGIBLE: "false", REASON: "no positive Ally signal" });
  assert.equal(status, 0);
  assert.match(stdout, /not eligible, heavy lanes stay held/);
  assert.deepEqual(calls, []);
});

test("unlock fails loudly, without writing, when the API errors", async () => {
  const routes = baseRoutes([livePull()]).filter(([method]) => method === "GET").slice(0, 1);
  const { status, stdout, calls } = await unlockAgainst(routes, {});
  assert.equal(status, 1);
  assert.match(stdout, /::error title=ally-verdict unlock::GitHub API 404/);
  assert.equal(calls.filter((c) => c.startsWith("POST")).length, 0);
});

// GITHUB_OUTPUT is a real file, as in runBash: `outputs` is exactly what the
// evaluate and unlock steps read.
const resolveAgainst = (routes, env) =>
  withGithubOutput((file) => scriptAgainst("resolve", routes, { DEFAULT_BRANCH: "master", ...env, GITHUB_OUTPUT: file }));
const headPullsRoute = (pulls) => [["GET", new RegExp(`^/repos/Blockcast/paperclip/commits/${H}/pulls\\?per_page=100$`), () => [200, pulls]]];

test("resolve: the verdict arm names the PR from the check_run's head, never from an input", async () => {
  const fork = { ...livePull(), number: 3, head: { ...livePull().head, repo: { full_name: "x/paperclip" } } };
  // INPUT_PR_NUMBER is empty on this arm in production; a stray value must not win either.
  for (const input of ["", "9"]) {
    const { status, stdout, outputs, calls } = await resolveAgainst(headPullsRoute([fork, livePull()]), { EVENT_NAME: "check_run", CHECK_HEAD_SHA: H, INPUT_PR_NUMBER: input });
    assert.equal(status, 0, stdout);
    assert.equal(outputs, `pr_number=7\nhead_sha=${H}\n`, `input ${JSON.stringify(input)}`);
    assert.deepEqual(calls, [`GET /repos/Blockcast/paperclip/commits/${H}/pulls?per_page=100`]);
  }
  // No open same-repo PR at that head: empty outputs, so the later steps skip.
  const none = await resolveAgainst(headPullsRoute([fork]), { EVENT_NAME: "check_run", CHECK_HEAD_SHA: H, INPUT_PR_NUMBER: "" });
  assert.equal(none.status, 0, none.stdout);
  assert.equal(none.outputs, "pr_number=\nhead_sha=\n");
  assert.match(none.stdout, /nothing to unlock/);
});

test("resolve: the manual arm takes a validated PR number and reads its live head", async () => {
  const ok = await resolveAgainst(baseRoutes([livePull()]).slice(0, 1), { EVENT_NAME: "workflow_dispatch", INPUT_PR_NUMBER: "7", CHECK_HEAD_SHA: "" });
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(ok.outputs, `pr_number=7\nhead_sha=${H}\n`);
  assert.deepEqual(ok.calls, ["GET /repos/Blockcast/paperclip/pulls/7"]);
  for (const input of ["", "07", "7 ", "7;id", "-1"]) {
    const bad = await resolveAgainst([], { EVENT_NAME: "workflow_dispatch", INPUT_PR_NUMBER: input, CHECK_HEAD_SHA: "" });
    assert.equal(bad.status, 1, `input ${JSON.stringify(input)}`);
    assert.equal(bad.outputs, "", "a refused input writes no outputs");
    assert.match(bad.stdout, /::error title=ally-verdict resolve::pr_number is not a PR number/);
    assert.deepEqual(bad.calls, [], "an invalid input never reaches the API");
  }
});

// A default branch that is not `master`, so a hard-coded ref cannot pass.
const BACKSTOP_BASE = "trunk";
const backstopRoutes = (prs) => [
  [
    "POST",
    /^\/graphql$/,
    () => [200, { data: { repository: { defaultBranchRef: { name: BACKSTOP_BASE }, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: prs } } } }],
  ],
  ["POST", /^\/repos\/Blockcast\/paperclip\/actions\/workflows\/dispatch-ally-verdict-ci\.yml\/dispatches$/, () => [204, null]],
];
const dispatchesIn = (bodies) =>
  bodies.filter(({ call }) => call === "POST /repos/Blockcast/paperclip/actions/workflows/dispatch-ally-verdict-ci.yml/dispatches").map(({ body }) => body);
const heldPr = (number, ally) => prNode({ number }, { ally, base: BACKSTOP_BASE });

test("backstop dispatches the manual arm at the default branch, once per held head, capped at 10", async () => {
  const prs = [heldPr(4, [B(1, "NEUTRAL")]), ...Array.from({ length: 12 }, (_, i) => heldPr(100 + i, [B(1, "SUCCESS")]))];
  const { status, stdout, bodies } = await scriptAgainst("backstop", backstopRoutes(prs), {});
  assert.equal(status, 0, stdout);
  const sent = dispatchesIn(bodies);
  assert.equal(sent.length, 10, "at most 10 per sweep");
  for (const body of sent) {
    assert.deepEqual(Object.keys(body).sort(), ["inputs", "ref"]);
    assert.equal(body.ref, BACKSTOP_BASE, "trusted code only: the dispatcher runs at the default branch (I4)");
    assert.match(body.inputs.pr_number, /^1(0\d|1[01])$/);
  }
  assert.deepEqual(sent.map((body) => body.inputs.pr_number), Array.from({ length: 10 }, (_, i) => String(100 + i)));
  assert.match(stdout, /2 over the cap wait for the next sweep/);
});

test("backstop under the kill switch releases a head held before it was thrown; unset, it does not", async () => {
  const prs = [heldPr(4, [B(1, "NEUTRAL")]), prNode({ number: 5, isDraft: true }, { base: BACKSTOP_BASE })];
  const off = await scriptAgainst("backstop", backstopRoutes(prs), { ALLY_GATED_CI_BYPASS: "" });
  assert.equal(off.status, 0, off.stdout);
  assert.deepEqual(dispatchesIn(off.bodies), []);
  for (const value of ["true", "TRUE"]) {
    const on = await scriptAgainst("backstop", backstopRoutes(prs), { ALLY_GATED_CI_BYPASS: value });
    assert.equal(on.status, 0, on.stdout);
    assert.deepEqual(dispatchesIn(on.bodies), [{ ref: BACKSTOP_BASE, inputs: { pr_number: "4" } }]);
    assert.match(on.stdout, /ALLY_GATED_CI_BYPASS=true/);
  }
});
