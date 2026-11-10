#!/usr/bin/env node
// Pull-request heavy-lane carry-forward (BLO-51600, CTO ruling 2026-11-10).
//
// The PR workflow re-runs every General tests shard on each push, including a
// push that only changes a comment or a doc after the lane already passed. On
// `arc-paperclip-general` that superseded work measured 5,223 runner-min/day.
// This is the merge-group trim pattern (scripts/merge-group-trim.mjs) applied
// to `pull_request`: a lane is skipped on head N when
//
//   1. an earlier head M of the SAME pull request really ran the lane to
//      success (any attempt; laneVerdict(): every leg green, the proof steps
//      ran, result no older than MAX_RESULT_AGE_HOURS), walking back from the
//      newest earlier head past heads that never reached a verdict (cancelled
//      by the next push, or themselves skipped) but STOPPING at a head whose
//      lane failed; and
//   2. scripts/select-ci-suites.mjs, run on the M->N tree diff, reports the
//      lane's group as literally `needed: false`.
//
// A rebase or master merge between M and N puts master's changes in the M->N
// diff, so the selector decides "run" whenever they can reach the lane.
//
// FAILS OPEN: anything not positively established means "run", the script
// never exits non-zero, and pr.yml skips only on the literal 'true'. pr.yml runs
// the PR BASE's copy of this file and of the two it imports, never the PR's.
// Kill switch: repository variable PAPERCLIP_CI_PR_FULL_SUITE=true.
//
// Interaction, stated plainly: a carried head has no proof steps of its own, so
// the merge-group trim cannot trim that PR and the queue runs the lane on the
// merged tree. Carry-forward moves that lane off the general pool, never past
// the queue.

import { execFileSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_RESULT_AGE_HOURS, laneVerdict } from "./merge-group-trim.mjs";
import { decide as selectSuites } from "./select-ci-suites.mjs";

export const KILL_SWITCH_VARIABLE = "PAPERCLIP_CI_PR_FULL_SUITE";
export const MAX_HEADS = 6;

export const CARRY_LANES = {
  general_server: {
    group: "server_tests_needed",
    matrix: /^General tests \(server (\d+)\/(\d+)\)$/,
    proofSteps: ["Run grouped general test suites", "Run serialized server test shard"],
  },
  workspaces_a: {
    group: "workspaces_a_tests_needed",
    name: "General tests (workspaces-a)",
    proofSteps: ["Run grouped general test suites"],
  },
  workspaces_b: {
    group: "workspaces_b_tests_needed",
    name: "General tests (workspaces-b)",
    proofSteps: ["Run grouped general test suites"],
  },
};

// The selector already treats pr.yml/.github/actions as always-relevant; these
// are the files that decide carry-forward itself.
export const CI_CONTROL_PATHS = [
  /^\.github\/workflows\/pr\.yml$/,
  /^\.github\/actions\//,
  /^scripts\/pr-carry-forward\.mjs$/,
  /^scripts\/merge-group-trim\.mjs$/,
  /^scripts\/select-ci-suites\.mjs$/,
];

const SHA = /^[0-9a-f]{40}$/;
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

function laneJobs(jobs, lane) {
  return jobs.filter((j) => (lane.matrix ? lane.matrix.test(j.name) : j.name === lane.name));
}

// Did the newest completed attempt of any leg of this lane fail on its merits?
export function laneFailed(jobs, lane) {
  const newest = new Map();
  for (const j of laneJobs(jobs, lane)) {
    if (j.status !== "completed" || !j.completed_at) continue;
    const prev = newest.get(j.name);
    if (!prev || Date.parse(j.completed_at) > Date.parse(prev.completed_at)) newest.set(j.name, j);
  }
  return [...newest.values()].find((j) => FAILED.has(j.conclusion)) ?? null;
}

// Newest earlier head that really passed the lane, or why there is none.
export function findPassedHead(history, lane, now, maxAgeHours = MAX_RESULT_AGE_HOURS) {
  for (const { headSha, jobs } of history) {
    const verdict = laneVerdict(jobs, lane, now, maxAgeHours);
    if (verdict.passed) return { headSha };
    const failed = laneFailed(jobs, lane);
    if (failed) return { headSha: null, why: `earlier head ${headSha} failed ${failed.name}` };
  }
  return { headSha: null, why: "no earlier head of this PR passed the lane" };
}

export function noCarry(reason) {
  const lanes = {};
  for (const key of Object.keys(CARRY_LANES)) lanes[key] = { carry: false, why: reason };
  return { reason, lanes };
}

// Pure decision. `select(mSha)` returns select-ci-suites decisions for the
// M->N diff, or throws; any throw or anything but `needed === false` runs.
export function decideCarry(facts, select, now = Date.now()) {
  if (facts.eventName !== "pull_request") return noCarry(`event ${facts.eventName || "<none>"} is not pull_request`);
  if (String(facts.killSwitch ?? "").trim().toLowerCase() === "true") {
    return noCarry(`kill switch ${KILL_SWITCH_VARIABLE}=true: full suite`);
  }
  if (!SHA.test(facts.headSha ?? "")) return noCarry("PR head SHA unavailable");
  if (!Array.isArray(facts.history)) return noCarry("earlier heads of this PR could not be read");

  const lanes = {};
  const selections = new Map();
  for (const [key, lane] of Object.entries(CARRY_LANES)) {
    const found = findPassedHead(facts.history, lane, now, facts.maxAgeHours ?? MAX_RESULT_AGE_HOURS);
    if (!found.headSha) {
      lanes[key] = { carry: false, why: found.why };
      continue;
    }
    const m = found.headSha;
    if (!selections.has(m)) {
      try {
        const r = select(m);
        if (r?.controlPath) selections.set(m, { error: `M->N diff touches CI-control path ${r.controlPath}` });
        else selections.set(m, { decisions: r?.decisions });
      } catch (error) {
        selections.set(m, { error: `selector fault: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    const s = selections.get(m);
    const d = s.decisions?.[lane.group];
    if (s.error) lanes[key] = { carry: false, why: s.error };
    else if (d?.needed === false) lanes[key] = { carry: true, why: `head ${m} passed; M->N diff cannot reach ${lane.group}` };
    else lanes[key] = { carry: false, why: `M->N diff from ${m} reaches the lane${d?.trigger ? ` (${d.trigger.why}: ${d.trigger.file})` : ""}` };
  }
  return { reason: `PR head ${facts.headSha}`, lanes };
}

export function formatOutputs(decision) {
  return Object.keys(CARRY_LANES)
    .map((key) => `carry_forward_${key}=${decision.lanes[key]?.carry === true ? "true" : "false"}`)
    .join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Fact gathering. Every failure leaves a fact absent, which decideCarry() runs.
// ---------------------------------------------------------------------------

async function gh(apiUrl, repo, token, route) {
  const res = await fetch(`${apiUrl}/repos/${repo}${route}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GET ${route}: HTTP ${res.status}`);
  return res.json();
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
}

// Earlier heads of PR `number`, newest first, each with every attempt's jobs.
export async function readHistory({ api, repo, token, number, headRef, headSha }) {
  const runs = await gh(api, repo, token,
    `/actions/workflows/pr.yml/runs?event=pull_request&branch=${encodeURIComponent(headRef)}&per_page=50`);
  const byHead = new Map();
  for (const run of runs.workflow_runs ?? []) {
    if (run.head_sha === headSha || !(run.pull_requests ?? []).some((p) => p.number === number)) continue;
    if (!byHead.has(run.head_sha)) byHead.set(run.head_sha, { at: run.created_at, runs: [] });
    byHead.get(run.head_sha).runs.push(run);
  }
  const heads = [...byHead.entries()].sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)).slice(0, MAX_HEADS);
  const history = [];
  for (const [sha, { runs: headRuns }] of heads) {
    const jobs = [];
    for (const run of headRuns) {
      for (let page = 1; page <= 5; page++) {
        const r = await gh(api, repo, token, `/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`);
        jobs.push(...(r.jobs ?? []));
        if ((r.jobs ?? []).length < 100) break;
      }
    }
    history.push({ headSha: sha, jobs });
  }
  return history;
}

export function selectorFor(root, headSha, selectFn = selectSuites) {
  return (m) => {
    if (!SHA.test(m)) throw new Error(`earlier head ${m} malformed`);
    try {
      git(root, ["cat-file", "-e", `${m}^{commit}`]);
    } catch {
      git(root, ["fetch", "--no-tags", "--quiet", "origin", m]);
    }
    const changed = git(root, ["diff", "--name-only", "--no-renames", "-z", m, headSha]).toString().split("\0").filter(Boolean);
    const controlPath = changed.find((p) => CI_CONTROL_PATHS.some((re) => re.test(p)));
    if (controlPath) return { controlPath };
    // decide() never throws; an empty diff is "run everything".
    return { decisions: selectFn({ root, changed }) };
  };
}

export function summarize(decision, notes = []) {
  const rows = Object.entries(decision.lanes)
    .map(([key, v]) => `| ${key} | ${v.carry ? "skipped (carried forward)" : "runs"} | ${v.why} |`)
    .join("\n");
  return (
    `### Pull-request heavy-lane carry-forward\n\n${decision.reason}\n\n` +
    `Kill switch: set the repository variable \`${KILL_SWITCH_VARIABLE}=true\` to run the full suite.\n\n` +
    `| lane | this head | why |\n|---|---|---|\n${rows}\n` +
    (notes.length ? `\nFail-open notes:\n${notes.map((n) => `- ${n}`).join("\n")}\n` : "")
  );
}

async function main() {
  const env = process.env;
  const root = env.PR_CARRY_FORWARD_REPO_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const facts = { eventName: env.GITHUB_EVENT_NAME, killSwitch: env.PR_FULL_SUITE, headSha: env.PR_HEAD_SHA };
  const notes = [];
  let decision;
  try {
    const killed = String(facts.killSwitch ?? "").trim().toLowerCase() === "true";
    if (facts.eventName === "pull_request" && !killed && SHA.test(facts.headSha ?? "")) {
      facts.history = await readHistory({
        api: env.GITHUB_API_URL || "https://api.github.com",
        repo: env.GITHUB_REPOSITORY,
        token: env.GH_TOKEN,
        number: Number(env.PR_NUMBER),
        headRef: env.PR_HEAD_REF,
        headSha: facts.headSha,
      });
    }
  } catch (error) {
    notes.push(String(error?.message ?? error));
  }
  try {
    decision = decideCarry(facts, selectorFor(root, facts.headSha));
  } catch (error) {
    decision = noCarry(`carry-forward decision error: ${error?.message ?? error}`);
  }
  console.log(decision.reason);
  for (const [key, v] of Object.entries(decision.lanes)) console.log(`carry_forward_${key}=${v.carry}  (${v.why})`);
  for (const note of notes) console.log(`::warning title=carry-forward fell back to the full suite::${note}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, formatOutputs(decision));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summarize(decision, notes));
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch((error) => console.log(`::warning title=carry-forward fell back to the full suite::${error?.message ?? error}`));
}
