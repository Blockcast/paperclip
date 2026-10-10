#!/usr/bin/env node
// Merge-group heavy-lane trim. Owner directives 2026-10-07 ("reduce and isolate
// CPU waste from CI ... jobs running without new signal") and 2026-10-09 ("do
// it now"): stop re-running the full PR suite in `merge_group`.
//
// pr.yml's `policy` job runs this once per merge-group run and publishes one
// boolean per HEAVY lane. A heavy lane is skipped in the merge group only when
// the queued PR's own head already passed that lane in `pull_request` CI AND
// the queue is merging exactly the change set that CI tested. The
// merge-sensitive lanes -- policy, Helm chart, Typecheck + Release Registry,
// Build, the workspaces-a/-b unit tests, the vendored adapter and `verify` --
// are not listed here and always run against the merged tree.
//
// FAILS OPEN, like scripts/select-ci-suites.mjs: every lane is "run" unless
// EVERY condition below is positively established, the script never exits
// non-zero, and the pr.yml consumers only skip on the literal 'true'. So a
// fault here can only re-run work, never skip it.
//
// Conditions, all required:
//   1. the event is merge_group and the kill switch (repository variable
//      PAPERCLIP_CI_MERGE_GROUP_FULL_SUITE=true) is not set;
//   2. the merge group targets the repository's default branch, and its ref
//      (gh-readonly-queue/<base>/pr-<N>-<parent>) names one PR whose parent IS
//      merge_group.base_sha. Measured: base_sha is the previous queue entry's
//      head (or master), so base..head is this PR's change set and nothing else;
//   3. the PR is open against that base branch and its head SHA is readable;
//   4. the change set touches no CI-control path (pr.yml, .github/actions/,
//      this script, master-health.yml): a PR that changes how CI runs, or the
//      post-merge backstop the trim relies on, proves itself on the full suite;
//   5. the queue applied exactly the change set PR CI tested, proven twice on
//      git objects: `git patch-id --verbatim` (the stable algorithm, with
//      whitespace kept) of base..head equals that of the PR head's diff
//      against its merge-base with the queue parent, AND the merge-group tree
//      equals
//      `git merge-tree --write-tree` of the queue parent and the PR head, i.e.
//      it is exactly git's own clean merge. patch-id alone ignores hunk line
//      numbers and would accept a relocated hunk (same refinement as the
//      Ally-gated CI design, section 3.3 steps 4-5);
//   6. per lane: in the PR head's own `pull_request` pr.yml runs, the newest
//      completed job of every leg of the lane concluded `success`, actually ran
//      the lane's proof steps (a path-selector skip is not a pass), covers the
//      whole shard matrix, and finished no more than MAX_RESULT_AGE_HOURS ago.
//
// Residual risk, stated plainly: a semantic conflict between this PR and work
// that landed after its PR CI ran (including an earlier entry of the same
// queue batch) that only a trimmed lane would catch is no longer caught before
// merge. Build, typecheck and the workspaces unit tests still run on the merged
// tree, and master-health.yml re-runs the server suites on the landed master
// head whenever its merge-group build did not run them (scripts/__tests__/
// merge-group-trim.test.mjs pins that gate). e2e and Canary Dry Run have NO
// post-merge backstop: nothing runs them on master (e2e.yml is
// workflow_dispatch only), so a trimmed landing's merged tree meets them only
// in a later PR's own, non-required, pull_request e2e.

import { execFileSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const KILL_SWITCH_VARIABLE = "PAPERCLIP_CI_MERGE_GROUP_FULL_SUITE";
export const MAX_RESULT_AGE_HOURS = 72;

// Output key -> how the lane appears in a pr.yml run. `job` is the pr.yml job
// id that consumes the output; `name` / `matrix` match the job's check name
// (a `matrix` lane needs every leg 1..N present and green); `proofSteps` must
// each have concluded `success` in the PR-head job, so a lane whose steps were
// skipped (path selector, or this trim) never counts as having passed.
export const TRIM_LANES = {
  general_server: {
    job: "general_tests",
    matrix: /^General tests \(server (\d+)\/(\d+)\)$/,
    proofSteps: ["Run grouped general test suites", "Run serialized server test shard"],
  },
  worktree_install: {
    job: "worktree_install",
    name: "Worktree install (NODE_ENV=production)",
    proofSteps: ["Install into the worktree", "Assert the install is complete"],
  },
  opencode_responses_replay: {
    job: "opencode_responses_replay",
    name: "OpenCode Responses replay",
    proofSteps: ["Replay framed and malformed Responses streams"],
  },
  opencode_k8s_seed_cold_start: {
    job: "opencode_k8s_seed_cold_start",
    name: "k8s-ro seed transport cold start",
    proofSteps: ["Run the focused regression three times from a clean OpenCode home"],
  },
  e2e: {
    job: "e2e",
    name: "e2e",
    proofSteps: ["Run e2e tests"],
  },
  canary_dry_run: {
    job: "canary_dry_run",
    name: "Canary Dry Run",
    proofSteps: ["Release canary dry run via release.sh internal build"],
  },
};

export const CI_CONTROL_PATHS = [
  /^\.github\/workflows\/pr\.yml$/,
  /^\.github\/actions\//,
  /^scripts\/merge-group-trim\.mjs$/,
  /^\.github\/workflows\/master-health\.yml$/,
];

const SHA = /^[0-9a-f]{40}$/;

export function parseQueueRef(headRef, baseRef = "refs/heads/master") {
  const branch = String(baseRef ?? "").replace(/^refs\/heads\//, "");
  const ref = String(headRef ?? "").replace(/^refs\/heads\//, "");
  const prefix = `gh-readonly-queue/${branch}/pr-`;
  if (!branch || !ref.startsWith(prefix)) return null;
  const m = /^(\d+)-([0-9a-f]{40})$/.exec(ref.slice(prefix.length));
  return m ? { pr: Number(m[1]), parentSha: m[2], baseBranch: branch } : null;
}

function inLane(job, lane) {
  return lane.matrix ? lane.matrix.test(job.name) : job.name === lane.name;
}

// Newest completed verdict per job name, across every run/attempt supplied.
function newestByName(jobs) {
  const out = new Map();
  for (const j of jobs) {
    if (j.status !== "completed" || !j.completed_at) continue;
    const prev = out.get(j.name);
    if (!prev || Date.parse(j.completed_at) > Date.parse(prev.completed_at)) out.set(j.name, j);
  }
  return [...out.values()];
}

// "server 3/6" legs: every N seen must have all of 1..N.
function missingLegs(newest, lane) {
  if (!lane.matrix) return null;
  const seen = new Map();
  for (const j of newest) {
    const [, i, n] = lane.matrix.exec(j.name);
    if (!seen.has(n)) seen.set(n, new Set());
    seen.get(n).add(Number(i));
  }
  for (const [n, legs] of seen) {
    for (let i = 1; i <= Number(n); i++) if (!legs.has(i)) return `leg ${i}/${n}`;
  }
  return null;
}

// Did this job really execute the lane (not merely conclude `success`)?
export function ranProofSteps(job, lane) {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  return lane.proofSteps.find((name) => !steps.some((s) => s.name === name && s.conclusion === "success")) ?? null;
}

export function laneVerdict(jobs, lane, now, maxAgeHours = MAX_RESULT_AGE_HOURS) {
  const newest = newestByName(jobs.filter((j) => inLane(j, lane)));
  if (newest.length === 0) return { passed: false, why: "no completed job on the PR head" };
  const bad = newest.find((j) => j.conclusion !== "success");
  if (bad) return { passed: false, why: `${bad.name} concluded ${bad.conclusion ?? "unknown"} on the PR head` };
  const missing = missingLegs(newest, lane);
  if (missing) return { passed: false, why: `no completed ${missing} on the PR head` };
  for (const j of newest) {
    const step = ranProofSteps(j, lane);
    if (step) return { passed: false, why: `${j.name} on the PR head did not run "${step}" to success` };
  }
  const oldest = Math.min(...newest.map((j) => Date.parse(j.completed_at)));
  const ageHours = (now - oldest) / 3_600_000;
  if (!(ageHours <= maxAgeHours)) {
    return { passed: false, why: `PR-head result is ${ageHours.toFixed(1)}h old (> ${maxAgeHours}h)` };
  }
  return { passed: true, why: `passed on the PR head (${newest.map((j) => j.html_url ?? j.name).join(", ")})` };
}

export function noTrim(reason) {
  const lanes = {};
  for (const key of Object.keys(TRIM_LANES)) lanes[key] = { trim: false, why: reason };
  return { reason, lanes };
}

// Pure decision over already-gathered facts; any fact absent => run.
export function decideTrim(facts, now = Date.now()) {
  if (facts.eventName !== "merge_group") return noTrim(`event ${facts.eventName || "<none>"} is not merge_group`);
  if (String(facts.killSwitch ?? "").trim().toLowerCase() === "true") {
    return noTrim(`kill switch ${KILL_SWITCH_VARIABLE}=true: full suite`);
  }
  const queue = parseQueueRef(facts.headRef, facts.baseRef);
  if (!queue) return noTrim(`unrecognised merge-group head ref ${facts.headRef || "<none>"}`);
  if (!facts.defaultBranch || queue.baseBranch !== facts.defaultBranch) {
    return noTrim(`merge group targets ${queue.baseBranch}, not the default branch ${facts.defaultBranch || "<unreadable>"}`);
  }
  if (!SHA.test(facts.baseSha ?? "") || queue.parentSha !== facts.baseSha) {
    return noTrim("merge_group.base_sha is not the queue ref's parent; cannot isolate this PR's change set");
  }
  if (!SHA.test(facts.headSha ?? "")) return noTrim("merge_group.head_sha unavailable");
  const pr = facts.pullRequest;
  if (!pr || pr.number !== queue.pr) return noTrim(`PR #${queue.pr} could not be read`);
  if (pr.state !== "open") return noTrim(`PR #${queue.pr} is ${pr.state}`);
  if (pr.baseRef !== queue.baseBranch) return noTrim(`PR #${queue.pr} targets ${pr.baseRef}, not ${queue.baseBranch}`);
  if (!SHA.test(pr.headSha ?? "")) return noTrim(`PR #${queue.pr} head SHA unavailable`);
  if (!Array.isArray(facts.changedPaths) || facts.changedPaths.length === 0) {
    return noTrim("merge-group change set unavailable or empty");
  }
  const control = facts.changedPaths.find((p) => CI_CONTROL_PATHS.some((re) => re.test(p)));
  if (control) return noTrim(`change set touches CI-control path ${control}: full suite`);
  if (facts.patchIdMatch !== true) {
    return noTrim("queue change set differs from the PR head's tested change set (patch-id --verbatim)");
  }
  if (facts.treeMatch !== true) {
    return noTrim("merge-group tree is not git's clean merge of the PR head onto the queue parent (merge-tree)");
  }
  if (!Array.isArray(facts.prHeadJobs)) return noTrim("PR-head pull_request jobs could not be read");

  const lanes = {};
  for (const [key, lane] of Object.entries(TRIM_LANES)) {
    const verdict = laneVerdict(facts.prHeadJobs, lane, now, facts.maxAgeHours ?? MAX_RESULT_AGE_HOURS);
    lanes[key] = { trim: verdict.passed, why: verdict.why };
  }
  return { reason: `PR #${queue.pr} head ${pr.headSha}`, lanes };
}

export function formatOutputs(decision) {
  const lines = Object.keys(TRIM_LANES).map(
    (key) => `merge_group_trim_${key}=${decision.lanes[key]?.trim === true ? "true" : "false"}`,
  );
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Fact gathering (network + git). Every failure leaves the fact absent, which
// decideTrim() turns into "run the lane".
// ---------------------------------------------------------------------------

async function gh(apiUrl, repo, token, route) {
  const res = await fetch(`${apiUrl}/repos/${repo}${route}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GET ${route}: HTTP ${res.status}`);
  return res.json();
}

function git(root, args, input) {
  return execFileSync("git", args, { cwd: root, input, maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "pipe"] });
}

export function patchId(root, from, to) {
  const diff = git(root, ["diff", "--no-color", "--no-ext-diff", from, to]);
  // `--verbatim` is the stable algorithm with whitespace kept; git refuses it
  // combined with `--stable` ("cannot be used together").
  return git(root, ["patch-id", "--verbatim"], diff).toString().trim().split(/\s+/)[0] ?? "";
}

// Tree of git's own merge of `theirs` onto `ours` from `base`; null on conflict.
export function mergeTree(root, base, ours, theirs) {
  try {
    const out = git(root, ["merge-tree", "--write-tree", "--no-messages", `--merge-base=${base}`, ours, theirs]);
    return out.toString().split("\n")[0].trim() || null;
  } catch {
    return null;
  }
}

export async function gatherFacts(env, root) {
  const facts = {
    eventName: env.GITHUB_EVENT_NAME,
    killSwitch: env.MERGE_GROUP_FULL_SUITE,
    headRef: env.MERGE_GROUP_HEAD_REF,
    baseRef: env.MERGE_GROUP_BASE_REF,
    baseSha: env.MERGE_GROUP_BASE_SHA,
    headSha: env.MERGE_GROUP_HEAD_SHA,
    defaultBranch: env.MERGE_GROUP_DEFAULT_BRANCH,
    notes: [],
  };
  // Nothing to gather when the decision is already "run everything".
  const queue = parseQueueRef(facts.headRef, facts.baseRef);
  if (facts.eventName !== "merge_group" || !queue) return facts;
  if (String(facts.killSwitch ?? "").trim().toLowerCase() === "true") return facts;
  if (!SHA.test(facts.baseSha ?? "") || !SHA.test(facts.headSha ?? "")) return facts;
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GH_TOKEN;
  try {
    const pr = await gh(api, repo, token, `/pulls/${queue.pr}`);
    facts.pullRequest = { number: pr.number, state: pr.state, baseRef: pr.base?.ref, headSha: pr.head?.sha };
  } catch (error) {
    facts.notes.push(String(error.message ?? error));
    return facts;
  }
  try {
    facts.changedPaths = git(root, ["diff", "--name-only", "--no-renames", "-z", `${facts.baseSha}..${facts.headSha}`])
      .toString()
      .split("\0")
      .filter(Boolean);
    const prHead = facts.pullRequest.headSha;
    if (!SHA.test(prHead ?? "")) return facts;
    git(root, ["fetch", "--no-tags", "--quiet", "origin", `+refs/pull/${queue.pr}/head:refs/merge-group-trim/pr-head`]);
    const resolved = git(root, ["rev-parse", "refs/merge-group-trim/pr-head"]).toString().trim();
    if (resolved !== prHead) throw new Error(`refs/pull/${queue.pr}/head is ${resolved}, API says ${prHead}`);
    const mergeBase = git(root, ["merge-base", prHead, facts.baseSha]).toString().trim();
    const queued = patchId(root, facts.baseSha, facts.headSha);
    facts.patchIdMatch = queued !== "" && queued === patchId(root, mergeBase, prHead);
    const groupTree = git(root, ["rev-parse", `${facts.headSha}^{tree}`]).toString().trim();
    facts.treeMatch = mergeTree(root, mergeBase, facts.baseSha, prHead) === groupTree;
  } catch (error) {
    facts.notes.push(String(error.message ?? error));
    return facts;
  }
  try {
    const runs = await gh(
      api,
      repo,
      token,
      `/actions/workflows/pr.yml/runs?event=pull_request&head_sha=${facts.pullRequest.headSha}&per_page=10`,
    );
    const jobs = [];
    for (const run of (runs.workflow_runs ?? []).slice(0, 5)) {
      const page = await gh(api, repo, token, `/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
      jobs.push(...(page.jobs ?? []));
    }
    facts.prHeadJobs = jobs;
  } catch (error) {
    facts.notes.push(String(error.message ?? error));
  }
  return facts;
}

export function summarize(decision, facts) {
  const rows = Object.entries(decision.lanes)
    .map(([key, v]) => `| ${key} | ${v.trim ? "skipped (PR head passed)" : "runs"} | ${v.why} |`)
    .join("\n");
  const notes = (facts.notes ?? []).map((n) => `- ${n}`).join("\n");
  return (
    `### Merge-group heavy-lane trim\n\n${decision.reason}\n\n` +
    `Kill switch: set the repository variable \`${KILL_SWITCH_VARIABLE}=true\` to run the full suite.\n\n` +
    `| lane | merge group | why |\n|---|---|---|\n${rows}\n${notes ? `\nFail-open notes:\n${notes}\n` : ""}`
  );
}

// pr.yml runs the merge group base's copy of this file from RUNNER_TEMP, so the
// checkout it decides about is named explicitly rather than derived from where
// the file sits.
export function repoRoot(env = process.env, scriptUrl = import.meta.url) {
  return env.MERGE_GROUP_TRIM_REPO_ROOT || path.resolve(path.dirname(fileURLToPath(scriptUrl)), "..");
}

async function main() {
  const root = repoRoot();
  let decision;
  let facts = {};
  try {
    facts = await gatherFacts(process.env, root);
    decision = decideTrim(facts);
  } catch (error) {
    decision = noTrim(`trim decision error: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(decision.reason);
  for (const [key, v] of Object.entries(decision.lanes)) console.log(`merge_group_trim_${key}=${v.trim}  (${v.why})`);
  for (const note of facts.notes ?? []) console.log(`::warning title=merge-group trim fell back to the full suite::${note}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, formatOutputs(decision));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summarize(decision, facts));
}

// realpath: import.meta.url is the resolved path, argv[1] may run through a symlink.
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.log(`::warning title=merge-group trim fell back to the full suite::${error?.message ?? error}`);
  });
}
