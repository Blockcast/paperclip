import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf8");

function policySteps() {
  const start = workflow.indexOf("\n  policy:\n");
  const end = workflow.indexOf("\n  helm_chart:\n", start);
  assert.notEqual(start, -1, "pr.yml must define policy");
  assert.notEqual(end, -1, "pr.yml must define helm_chart after policy");
  return workflow.slice(start, end).split("\n      - name: ").slice(1);
}

function nodeTestSteps() {
  return policySteps().filter((step) => step.includes("node --test"));
}

function assertTimeouts(steps) {
  assert.ok(steps.length > 0, "policy must contain node --test steps");
  for (const step of steps) {
    assert.match(step, /\n        timeout-minutes: 1\n/, "each policy node --test step must have a one-minute bound");
  }
}

test("every policy node --test step has a step-level timeout", () => {
  assertTimeouts(nodeTestSteps());
});

test("the timeout guard fails when a node --test bound is removed", () => {
  const mutated = nodeTestSteps().map((step) => step.replace("\n        timeout-minutes: 1\n", "\n"));
  assert.throws(() => assertTimeouts(mutated), /one-minute bound/);
});

test("policy continues after a bounded test failure unless cancelled", () => {
  const steps = policySteps();
  const firstNodeTest = steps.findIndex((step) => step.includes("node --test"));
  assert.notEqual(firstNodeTest, -1, "policy must contain a node --test step");
  for (const step of steps.slice(firstNodeTest + 1)) {
    assert.match(step, /\n        if: \$\{\{ !cancelled\(\)/, "later policy steps must continue after a test failure");
  }
});

// BLO-31405. The chart render suite forks `helm template` once per test file, so
// under the one-minute default asserted above its p100 of 73s (25 sampled runs)
// failed `policy` on duration alone — skipping every lane that `needs:` it, on
// PRs that never touched the chart. It belongs to the dedicated `helm_chart`
// job, which has a 10-minute budget and is itself a `verify` lane.
//
// It had already landed in both places at once: #965 added the policy step and
// #995 added the job, each comment claiming the tests "ran nowhere in CI". A
// note saying "do not re-add" would not have stopped that, because neither
// author read the other's file. So gate it, in both directions — exactly one
// invocation, owned by exactly that job. Deleting the coverage outright fails
// this too, which is the mistake that motivated the duplicate in the first
// place.
const CHART_SUITE = "deploy/helm/paperclip/tests/*.test.mjs";

function jobOwning(offset) {
  let owner = null;
  for (const match of workflow.matchAll(/\n {2}([a-z_]+):\n/g)) {
    if (match.index >= offset) break;
    owner = match[1];
  }
  return owner;
}

function jobRegion(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `pr.yml must define ${name}`);
  const after = workflow.slice(start + 1);
  const nextJob = after.search(/\n {2}[a-z_]+:\n/);
  return nextJob === -1 ? after : after.slice(0, nextJob + 1);
}

test("the chart render suite runs in exactly one job, and that job is helm_chart", () => {
  const offsets = [];
  for (let at = workflow.indexOf(CHART_SUITE); at !== -1; at = workflow.indexOf(CHART_SUITE, at + 1)) {
    offsets.push(at);
  }
  assert.equal(
    offsets.length,
    1,
    `pr.yml must invoke ${CHART_SUITE} exactly once, found ${offsets.length}`,
  );
  assert.equal(jobOwning(offsets[0]), "helm_chart", `${CHART_SUITE} must run in the helm_chart job`);
});

// BLO-29182 observed this exact invocation hang, and its fix bounded the copy
// that used to live in `policy`. Removing that copy has to carry the bound with
// it, or the one `node --test` step known to hang is unbounded again — a hung
// step would burn the whole job budget instead of failing attributably. The
// margin (4 min against a 73s p100) lives in the workflow comment; the
// invariant worth gating is only that a step bound exists and is under the cap.
test("the chart render step is bounded, and inside its job's budget (BLO-29182)", () => {
  const region = jobRegion("helm_chart");
  const jobCap = Number(region.match(/\n    timeout-minutes: (\d+)\n/)?.[1]);
  assert.ok(jobCap > 0, "helm_chart must declare a job-level timeout-minutes");
  const step = region
    .split("\n      - name: ")
    .slice(1)
    .find((candidate) => candidate.includes(CHART_SUITE));
  assert.ok(step, `helm_chart must contain the ${CHART_SUITE} step`);
  const stepBound = Number(step.match(/\n        timeout-minutes: (\d+)\n/)?.[1]);
  assert.ok(stepBound > 0, "the chart render step must declare a step-level timeout-minutes");
  assert.ok(stepBound < jobCap, `step bound ${stepBound}m must sit below the ${jobCap}m job cap`);
});

// BLO-31690. `policy`'s cap is sized against measured setup cost, and the larger,
// more variable half of that cost is its `fetch-depth: 0` checkout (0.5-4.6m over
// 120 runs). Until that bound was added the step carried none, so a wedged fetch
// could only ever surface as an unattributable job-cap `cancelled` — the exact
// mode the cap raise exists to remove, which makes the bound load-bearing rather
// than decorative. By this file's own convention that means gating it: the
// mutation case above exists because a bound nothing asserts is a bound that can
// be quietly deleted, and this one is the only step bound in `policy` that had no
// test behind it. The sizing argument (6m ≈ 1.3× the p100, why not 8m, and the
// residual band it leaves) lives in the workflow comment — deliberately without
// the figure here, since that band is a function of the drifting gate-work term
// and a copy of it in this file went stale within one commit (0.2m → 1.1m); the
// invariants worth gating are that the bound exists and that it stays under the
// cap, since a step bound at or above the job cap can never fire and silently
// stops being attribution.
function assertCheckoutBounded(region) {
  const jobCap = Number(region.match(/\n    timeout-minutes: (\d+)\n/)?.[1]);
  assert.ok(jobCap > 0, "policy must declare a job-level timeout-minutes");
  const step = region
    .split("\n      - name: ")
    .slice(1)
    .find((candidate) => candidate.includes("uses: actions/checkout@"));
  assert.ok(step, "policy must contain an actions/checkout step");
  const stepBound = Number(step.match(/\n        timeout-minutes: (\d+)\n/)?.[1]);
  assert.ok(stepBound > 0, "policy's checkout step must declare a step-level timeout-minutes");
  assert.ok(
    stepBound < jobCap,
    `checkout bound ${stepBound}m must sit below the ${jobCap}m job cap`,
  );
}

test("policy's checkout step is bounded, and inside the job's budget (BLO-31690)", () => {
  assertCheckoutBounded(jobRegion("policy"));
});

test("the checkout guard fails when the bound is removed", () => {
  const region = jobRegion("policy");
  const at = region.indexOf("uses: actions/checkout@");
  assert.notEqual(at, -1, "policy must contain an actions/checkout step");
  // Strip only the bound belonging to the checkout step: the first 8-space
  // `timeout-minutes` at or after its `uses:` line.
  const mutated =
    region.slice(0, at) + region.slice(at).replace(/\n {8}timeout-minutes: \d+\n/, "\n");
  assert.throws(() => assertCheckoutBounded(mutated), /step-level timeout-minutes/);
});
