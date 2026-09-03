import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf8");

const DEFAULT_TIMEOUT_MINUTES = 1;

// Steps that need more than the default minute. Every entry must carry the
// measurement that justifies it, and the bound is matched EXACTLY: raising a
// step past its declared allowance fails this gate just as removing the bound
// does, so an exception cannot be widened silently once it exists.
const TIMEOUT_ALLOWANCES = [
  {
    // BLO-31405. 18 test files, each forking `helm template`; it is the only
    // policy step that pays a process-spawn cost per file. Sampled over the 25
    // most recent pr.yml runs the step's p100 is 73s, and three runs (64s, 64s,
    // 73s) blew the old 60s bound — each one failing `policy` and skipping every
    // lane that `needs:` it, on PRs that never touched the chart. 4 min is 3.3x
    // that p100. If the suite grows enough to need more, render the chart once
    // and assert against the cached manifest rather than widening this again.
    name: "Test Helm chart render suite",
    minutes: 4,
  },
];

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

function stepName(step) {
  return step.split("\n")[0];
}

function allowanceFor(step) {
  return TIMEOUT_ALLOWANCES.find((entry) => step.startsWith(entry.name));
}

function expectedMinutes(step) {
  return allowanceFor(step)?.minutes ?? DEFAULT_TIMEOUT_MINUTES;
}

function boundPattern(minutes) {
  return new RegExp(`\\n        timeout-minutes: ${minutes}\\n`);
}

function assertTimeouts(steps) {
  assert.ok(steps.length > 0, "policy must contain node --test steps");
  for (const step of steps) {
    const minutes = expectedMinutes(step);
    assert.match(
      step,
      boundPattern(minutes),
      `policy step "${stepName(step)}" must declare timeout-minutes: ${minutes}`,
    );
  }
}

test("every policy node --test step declares its bound", () => {
  assertTimeouts(nodeTestSteps());
});

// The negative control. Removing ANY single bound must fail the guard —
// checked per step rather than by stripping them all at once, so the allowlisted
// exception is covered by this control exactly as the defaulted steps are.
test("the timeout guard fails when any single node --test bound is removed", () => {
  const steps = nodeTestSteps();
  for (const [index, step] of steps.entries()) {
    const mutated = steps.map((other, otherIndex) =>
      otherIndex === index ? other.replace(/\n {8}timeout-minutes: \d+\n/, "\n") : other,
    );
    assert.notDeepEqual(mutated, steps, `removing the bound on "${stepName(step)}" must change the step`);
    assert.throws(
      () => assertTimeouts(mutated),
      /must declare timeout-minutes/,
      `dropping the bound on "${stepName(step)}" must fail the guard`,
    );
  }
});

// The exception must not be a back door: a step bounded above its declared
// allowance fails too, so widening one means editing TIMEOUT_ALLOWANCES and
// writing down why.
test("the timeout guard fails when a node --test bound is raised past its allowance", () => {
  const steps = nodeTestSteps();
  for (const [index, step] of steps.entries()) {
    const inflated = expectedMinutes(step) + 1;
    const mutated = steps.map((other, otherIndex) =>
      otherIndex === index
        ? other.replace(/\n {8}timeout-minutes: \d+\n/, `\n        timeout-minutes: ${inflated}\n`)
        : other,
    );
    assert.throws(
      () => assertTimeouts(mutated),
      /must declare timeout-minutes/,
      `raising "${stepName(step)}" to ${inflated}m must fail the guard`,
    );
  }
});

// Keeps the allowlist honest in the other direction: a renamed or deleted step
// must not leave a stale entry behind that would silently license a future step
// whose name happens to collide with it.
test("every declared timeout allowance matches exactly one policy node --test step", () => {
  const steps = nodeTestSteps();
  for (const entry of TIMEOUT_ALLOWANCES) {
    const matched = steps.filter((step) => step.startsWith(entry.name));
    assert.equal(
      matched.length,
      1,
      `timeout allowance "${entry.name}" must match exactly one policy node --test step, matched ${matched.length}`,
    );
    assert.ok(entry.minutes > DEFAULT_TIMEOUT_MINUTES, `allowance "${entry.name}" is not an exception`);
  }
});

// No collateral loosening: every step outside the allowlist stays at the default.
test("only allowlisted policy node --test steps deviate from the default bound", () => {
  for (const step of nodeTestSteps()) {
    if (allowanceFor(step)) continue;
    assert.match(
      step,
      boundPattern(DEFAULT_TIMEOUT_MINUTES),
      `policy step "${stepName(step)}" is not allowlisted, so it must keep the ${DEFAULT_TIMEOUT_MINUTES}-minute default`,
    );
  }
});

test("policy continues after a bounded test failure unless cancelled", () => {
  const steps = policySteps();
  const firstNodeTest = steps.findIndex((step) => step.includes("node --test"));
  assert.notEqual(firstNodeTest, -1, "policy must contain a node --test step");
  for (const step of steps.slice(firstNodeTest + 1)) {
    assert.match(step, /\n        if: \$\{\{ !cancelled\(\)/, "later policy steps must continue after a test failure");
  }
});
