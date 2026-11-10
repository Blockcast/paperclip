import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { CARRY_LANES, KILL_SWITCH_VARIABLE, decideCarry, formatOutputs, selectorFor } from "../pr-carry-forward.mjs";
import { buildContext, decide } from "../select-ci-suites.mjs";

// Contract for the pull_request heavy-lane carry-forward (BLO-51600, CTO ruling
// 2026-11-10, AC5). Pinned: skip only when the selector reports literally
// `false`; any fault means run; a rebase between M and N means run; an M that
// did not pass the lane means run.

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const workflow = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf8");
const N = "a".repeat(40);
const M = "b".repeat(40);
const L = "c".repeat(40);
const NOW = Date.parse("2026-11-10T12:00:00Z");
const DONE = "2026-11-10T08:00:00Z";
const LANES = Object.keys(CARRY_LANES);

function job(name, conclusion = "success", { proof = true, completed_at = DONE } = {}) {
  const lane = Object.values(CARRY_LANES).find((l) => (l.matrix ? l.matrix.test(name) : l.name === name));
  const stepConclusion = proof ? (conclusion === "success" ? "success" : conclusion) : "skipped";
  return { name, status: "completed", conclusion, completed_at, steps: lane.proofSteps.map((s) => ({ name: s, conclusion: stepConclusion })) };
}
const generalJobs = (opts) => [
  ...Array.from({ length: 6 }, (_, i) => job(`General tests (server ${i + 1}/6)`, "success", opts)),
  job("General tests (workspaces-a)", "success", opts),
  job("General tests (workspaces-b)", "success", opts),
];
const facts = (overrides = {}) => ({
  eventName: "pull_request",
  killSwitch: "",
  headSha: N,
  history: [{ headSha: M, jobs: generalJobs() }],
  ...overrides,
});
const notNeeded = () => ({
  decisions: Object.fromEntries(Object.values(CARRY_LANES).map((l) => [l.group, { needed: false, trigger: null }])),
});
const carried = (d) => LANES.filter((k) => d.lanes[k].carry);

test("carries every lane when M passed and the selector reports false on M->N", () => {
  const seen = [];
  const d = decideCarry(facts(), (m) => (seen.push(m), notNeeded()), NOW);
  assert.deepEqual(carried(d), LANES);
  assert.deepEqual(seen, [M], "selector runs once per distinct M, on M");
  assert.equal(formatOutputs(d), LANES.map((k) => `carry_forward_${k}=true`).join("\n") + "\n");
});

test("skip ONLY when the selector reports literally false", () => {
  for (const needed of [true, undefined, null, "false", 0, "true"]) {
    const sel = () => ({ decisions: Object.fromEntries(Object.values(CARRY_LANES).map((l) => [l.group, { needed }])) });
    assert.deepEqual(carried(decideCarry(facts(), sel, NOW)), [], String(needed));
  }
  assert.deepEqual(carried(decideCarry(facts(), () => ({ decisions: {} }), NOW)), [], "group missing");
  assert.deepEqual(carried(decideCarry(facts(), () => null, NOW)), [], "no decisions");
});

test("any script fault means run", () => {
  const d = decideCarry(facts(), () => { throw new Error("git fetch failed"); }, NOW);
  assert.deepEqual(carried(d), []);
  assert.match(d.lanes.general_server.why, /selector fault/);
  for (const bad of [{ history: undefined }, { headSha: "abc" }, { eventName: "merge_group" }, { eventName: undefined }]) {
    assert.deepEqual(carried(decideCarry(facts(bad), notNeeded, NOW)), [], JSON.stringify(bad));
  }
  assert.equal(formatOutputs({ lanes: {} }), LANES.map((k) => `carry_forward_${k}=false`).join("\n") + "\n");
});

for (const value of ["true", "TRUE", " true\n"]) {
  test(`kill switch ${KILL_SWITCH_VARIABLE}=${JSON.stringify(value)} runs every lane`, () => {
    assert.deepEqual(carried(decideCarry(facts({ killSwitch: value }), notNeeded, NOW)), []);
  });
}

test("an M that did not pass the lane means run", () => {
  const cases = {
    "no earlier head": [],
    "M failed": [{ headSha: M, jobs: generalJobs().map((j) => (j.name.includes("server 3/6") ? job(j.name, "failure") : j)) }],
    "M timed out": [{ headSha: M, jobs: generalJobs().map((j) => (j.name.includes("server 3/6") ? job(j.name, "timed_out") : j)) }],
    "M missing a shard": [{ headSha: M, jobs: generalJobs().filter((j) => !j.name.includes("server 6/6")) }],
    "M skipped the lane (no proof steps)": [{ headSha: M, jobs: generalJobs({ proof: false }) }],
    "M result too old": [{ headSha: M, jobs: generalJobs({ completed_at: "2026-11-01T00:00:00Z" }) }],
    // A failure on the newest earlier head stops the walk even if an older head passed.
    "newest failed, older passed": [
      { headSha: M, jobs: generalJobs().map((j) => (j.name.includes("server 1/6") ? job(j.name, "failure") : j)) },
      { headSha: L, jobs: generalJobs() },
    ],
  };
  for (const [name, history] of Object.entries(cases)) {
    assert.deepEqual(carried(decideCarry(facts({ history }), notNeeded, NOW)).filter((k) => k === "general_server"), [], name);
  }
});

test("a pass at attempt >= 2 counts: newest attempt per leg decides", () => {
  const retried = generalJobs().flatMap((j) =>
    j.name.includes("server 2/6") ? [job(j.name, "failure", { completed_at: "2026-11-10T07:00:00Z" }), j] : [j]);
  assert.deepEqual(carried(decideCarry(facts({ history: [{ headSha: M, jobs: retried }] }), notNeeded, NOW)), LANES);
});

test("walks past an earlier head that never reached a verdict to the head that passed", () => {
  const cancelled = generalJobs().map((j) => ({ ...j, conclusion: "cancelled" }));
  const seen = [];
  const history = [{ headSha: M, jobs: cancelled }, { headSha: L, jobs: generalJobs() }];
  assert.deepEqual(carried(decideCarry(facts({ history }), (m) => (seen.push(m), notNeeded()), NOW)), LANES);
  assert.deepEqual(seen, [L], "the M->N diff is taken from the head that actually passed");
});

// ---------------------------------------------------------------------------
// Real git + the real selector: the diff is M->N trees, so a rebase between
// M and N widens it and the selector runs the lane.
// ---------------------------------------------------------------------------

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pr-carry-forward-"));
  dirs.push(dir);
  const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  const commit = (files, msg) => {
    for (const [f, c] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), c); }
    g("add", "-A"); g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg);
    return g("rev-parse", "HEAD");
  };
  g("init", "-q", "-b", "master");
  const base = commit({ "server/src/x.ts": "1\n", "docs/a.md": "a\n" }, "base");
  return { g, commit, base };
}
// The fixture holds only the diff; the real repo checkout supplies the selector's context.
let ctx;
const realSelector = ({ changed }) => decide({ root: REPO, changed, ctx: (ctx ??= buildContext(REPO)) });

test("nit push (doc-only M->N) carries forward with the real selector", () => {
  const { commit } = fixture();
  const m = commit({ "server/src/x.ts": "2\n" }, "M: real change");
  const n = commit({ "docs/foo.md": "nit\n" }, "N: doc nit");
  const d = decideCarry(facts({ headSha: n, history: [{ headSha: m, jobs: generalJobs() }] }), selectorFor(dirs.at(-1), n, realSelector), NOW);
  assert.ok(d.lanes.general_server.carry, d.lanes.general_server.why);
});

test("a rebase between M and N means run", () => {
  const { g, commit, base } = fixture();
  const m = commit({ "docs/foo.md": "pr\n" }, "M");
  g("checkout", "-q", "-b", "upstream", base);
  commit({ "server/src/x.ts": "master moved\n" }, "master: server change");
  g("checkout", "-q", "-b", "rebased");
  const n = commit({ "docs/foo.md": "pr\n" }, "N: M rebased onto moved master");
  const d = decideCarry(facts({ headSha: n, history: [{ headSha: m, jobs: generalJobs() }] }), selectorFor(dirs.at(-1), n, realSelector), NOW);
  assert.equal(d.lanes.general_server.carry, false, d.lanes.general_server.why);
  assert.match(d.lanes.general_server.why, /server\/src\/x\.ts/);
});

test("an M->N diff touching the carry-forward decider itself means run", () => {
  const { commit } = fixture();
  const m = commit({ "docs/foo.md": "1\n" }, "M");
  const n = commit({ "scripts/pr-carry-forward.mjs": "//\n" }, "N");
  const d = decideCarry(facts({ headSha: n, history: [{ headSha: m, jobs: generalJobs() }] }), selectorFor(dirs.at(-1), n, () => notNeeded().decisions), NOW);
  assert.deepEqual(carried(d), []);
  assert.match(d.lanes.general_server.why, /CI-control path/);
});

test("an unreachable earlier head (fetch fails) means run", () => {
  const { commit } = fixture();
  const n = commit({ "docs/foo.md": "1\n" }, "N");
  const d = decideCarry(facts({ headSha: n }), selectorFor(dirs.at(-1), n, () => notNeeded().decisions), NOW);
  assert.deepEqual(carried(d), []);
});

// ---------------------------------------------------------------------------
// pr.yml wiring.
// ---------------------------------------------------------------------------

test("pr.yml runs the PR BASE's copies of the decider and its imports, pull_request only", () => {
  const step = workflow.slice(workflow.indexOf("- name: Decide pull-request heavy-lane carry-forward"));
  const body = step.slice(0, step.indexOf("timeout-minutes"));
  assert.match(body, /github\.event_name == 'pull_request'/);
  assert.match(body, /continue-on-error: true/);
  assert.match(body, /for f in pr-carry-forward\.mjs merge-group-trim\.mjs select-ci-suites\.mjs/);
  assert.match(body, /git show "\$\{PR_BASE_SHA\}:scripts\/\$f"/);
  assert.doesNotMatch(body, /node \.\/scripts\/pr-carry-forward/);
});

test("general_tests skips on carry-forward only for the literal 'true', on pull_request, kill switch unset", () => {
  assert.match(workflow, /elif \[ "\$EVENT_NAME" = "pull_request" \] && \[ "\$pr_full_suite" != "true" \] && \[ "\$carry" = "true" \]; then/);
  for (const key of LANES) {
    assert.match(workflow, new RegExp(`carry_forward_${key}: \\$\\{\\{ steps\\.pr_carry_forward\\.outputs\\.carry_forward_${key} \\}\\}`));
  }
});
