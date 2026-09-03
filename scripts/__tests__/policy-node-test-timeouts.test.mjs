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
