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

// BLO-32670. This used to assert the literal `timeout-minutes: 1` on every
// step, which made the bound a fixed number rather than a sufficient one: a
// step whose measured p100 outgrew 60s could not be right-sized without failing
// this test, so the only in-repo remedy was to leave it as a tripwire. It fired
// exactly that way on 2026-09-07, red-lining a PR that had not touched the
// script under test. The invariant worth gating is the one already written for
// the chart render step below — that a bound EXISTS and sits under the job cap,
// so a hang still fails attributably instead of burning the whole job budget.
// Sizing is per-step evidence, and belongs with the step; see the workflow
// comments and the contention-sensitive floor asserted further down.
function policyJobCap() {
  const cap = Number(jobRegion("policy").match(/\n    timeout-minutes: (\d+)\n/)?.[1]);
  assert.ok(cap > 0, "policy must declare a job-level timeout-minutes");
  return cap;
}

function stepName(step) {
  return step.split("\n")[0].trim();
}

function assertTimeouts(steps, cap = policyJobCap()) {
  assert.ok(steps.length > 0, "policy must contain node --test steps");
  for (const step of steps) {
    const bound = Number(step.match(/\n        timeout-minutes: (\d+)\n/)?.[1]);
    assert.ok(
      bound > 0,
      `policy node --test step "${stepName(step)}" must declare a step-level timeout-minutes`,
    );
    assert.ok(
      bound < cap,
      `"${stepName(step)}" bound ${bound}m must sit below the ${cap}m policy job cap`,
    );
  }
}

test("every policy node --test step has a step-level timeout", () => {
  assertTimeouts(nodeTestSteps());
});

test("the timeout guard fails when a node --test bound is removed", () => {
  const mutated = nodeTestSteps().map((step) => step.replace(/\n {8}timeout-minutes: \d+\n/, "\n"));
  assert.throws(() => assertTimeouts(mutated), /must declare a step-level timeout-minutes/);
});

test("the timeout guard fails when a node --test bound reaches the job cap", () => {
  const cap = policyJobCap();
  const mutated = nodeTestSteps().map((step) =>
    step.replace(/\n {8}timeout-minutes: \d+\n/, `\n        timeout-minutes: ${cap}\n`),
  );
  assert.throws(() => assertTimeouts(mutated, cap), /must sit below the/);
});

// BLO-32670. Three of the 41 bounded steps in `policy` measured a p100 above
// 50% of the old 60s budget over 58 sampled runs; the other 38 were all at or
// under 25%. These three are the fork-heavy ones — they shell out per case, so
// their wall time tracks runner CPU contention rather than their own work,
// which is why they inflate while their neighbours (dominated by deliberate
// sleeps) barely move. Against the in-band contention barometer — this job's
// own unbounded `Checkout repository` step, which ranges 47s to 280s on the
// same runners — they correlate at r ~= 0.35 and run 2.3x slower in the
// high-load tercile, where trivial steps sit at r ~= 0.05 and 1.0x.
//
// Pinned as a floor, not an exact value, so raising one further stays a
// one-line change. What must fail loudly is a revert to 1: that reads as
// harmless cleanup, restores the tripwire, and the next red `policy` again
// lands on whichever PR happens to be in the contention window.
const CONTENTION_SENSITIVE_FLOOR_MINUTES = 3;
const CONTENTION_SENSITIVE_STEPS = [
  "Test approval admissibility-probe backoff (BLO-28471)",
  "Test pending-migration pre-flight phase budgets (BLO-31254)",
  "Test bounded PR-check polling skills",
];

function assertContentionFloor(steps) {
  for (const name of CONTENTION_SENSITIVE_STEPS) {
    const step = steps.find((candidate) => stepName(candidate) === name);
    assert.ok(step, `policy must still contain the contention-sensitive step "${name}"`);
    const bound = Number(step.match(/\n        timeout-minutes: (\d+)\n/)?.[1]);
    assert.ok(
      bound >= CONTENTION_SENSITIVE_FLOOR_MINUTES,
      `"${name}" is fork-heavy and measured a p100 above 50% of a one-minute budget, so its bound must stay at or above ${CONTENTION_SENSITIVE_FLOOR_MINUTES}m — found ${bound}m`,
    );
  }
}

test("fork-heavy policy steps keep a bound sized against their measured p100", () => {
  assertContentionFloor(policySteps());
});

test("the contention floor fails when a fork-heavy step is re-tightened to one minute", () => {
  const mutated = policySteps().map((step) =>
    CONTENTION_SENSITIVE_STEPS.includes(stepName(step))
      ? step.replace(/\n {8}timeout-minutes: \d+\n/, "\n        timeout-minutes: 1\n")
      : step,
  );
  assert.throws(() => assertContentionFloor(mutated), /must stay at or above/);
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
