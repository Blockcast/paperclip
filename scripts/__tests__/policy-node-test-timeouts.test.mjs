import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf8");

// BLO-31482. A chunk runs to the next `- name:`, so it swallows the blank line
// and comment block that a reader would attribute to the step BELOW it. That is
// invisible until a comment happens to contain text the filters match on:
// writing "this step is a `node --test` invocation" above one step pulled its
// PREDECESSOR into scope, and the guard then reported an unbounded step whose
// name had nothing to do with the edit. Trailing comment and blank lines are
// therefore not part of the step. This cannot hide a bound — `timeout-minutes`
// is matched at 8-space indent with no `#`, so a commented-out one never
// counted anyway.
function stripTrailingComments(step) {
  const lines = step.split("\n");
  while (lines.length > 1) {
    const last = lines[lines.length - 1].trim();
    if (last !== "" && !last.startsWith("#")) break;
    lines.pop();
  }
  // Re-terminate: `timeoutMinutes` matches `\n {8}timeout-minutes: N\n`, so a
  // step whose bound is its last line needs the trailing newline back or the
  // strip would read every such step as unbounded.
  return `${lines.join("\n")}\n`;
}

function policySteps() {
  const start = workflow.indexOf("\n  policy:\n");
  const end = workflow.indexOf("\n  helm_chart:\n", start);
  assert.notEqual(start, -1, "pr.yml must define policy");
  assert.notEqual(end, -1, "pr.yml must define helm_chart after policy");
  return workflow.slice(start, end).split("\n      - name: ").slice(1).map(stripTrailingComments);
}

// BLO-31482. This used to be `step.includes("node --test")`, which scoped the
// guard to how a step is *spelled* rather than to what it is. Three steps in
// `policy` therefore carried no bound at all, and two of them — `Test
// ip-address security override` and `Test browserslist security override` —
// were `node --test` invocations the whole time, hidden behind a pnpm script
// alias. The filter was already missing steps its own stated intent covered.
//
// So match on either: the literal invocation (keeps every step the old rule
// held, including the seven `Validate *`-named ones), or a `Test ` name
// (catches the pnpm-aliased and Python ones). Union, never replacement — a
// name-only rule would have dropped those seven.
//
// Setup steps are deliberately NOT in scope, and that is a measurement rather
// than an oversight. Over 59 sampled `policy` runs `Checkout repository` ranges
// 47s-266s (p90 170s) and `Set up Python` 24s-76s: a bound loose enough not to
// flake on those is ~5-6m against a 10m job cap, which buys almost no
// attribution while adding a new way to red-line an innocent PR. They keep the
// job cap until one of them is measured actually hanging, not merely slow.
// BLO-31482's option 2 — a bound on every step with an allowance table —
// reintroduces the allowlist machinery #1620 removed, and nothing yet justifies
// it.
function boundedTestSteps() {
  return policySteps().filter(
    (step) => step.includes("node --test") || stepName(step).startsWith("Test "),
  );
}

// BLO-32670. GitHub Actions accepts fractional minutes. Matching only `(\d+)`
// makes `timeout-minutes: 1.5` read as declaring no bound at all, so the guard
// rejects such a step with the exact opposite of what its author wrote. Parse
// the fraction and let the numeric comparisons below do the work.
const TIMEOUT_MINUTES = String.raw`timeout-minutes: (\d+(?:\.\d+)?)`;

function timeoutMinutes(text, indent) {
  return Number(text.match(new RegExp(`\\n {${indent}}${TIMEOUT_MINUTES}\\n`))?.[1]);
}

// Sizing is per-step evidence and belongs with the step; this reads only the
// ceiling that every step bound has to sit under.
function policyJobCap() {
  const cap = timeoutMinutes(jobRegion("policy"), 4);
  assert.ok(cap > 0, "policy must declare a job-level timeout-minutes");
  return cap;
}

function stepName(step) {
  return step.split("\n")[0].trim();
}

// BLO-32670. This used to assert the literal `timeout-minutes: 1` on every
// step, which made the bound a fixed number rather than a sufficient one: a
// step whose measured p100 outgrew 60s could not be right-sized without failing
// this test, so the only in-repo remedy was to leave it as a tripwire. It fired
// exactly that way on 2026-09-07, red-lining a PR that had not touched the
// script under test. The invariant worth gating is the one already written for
// the chart render step below — that a bound EXISTS and sits under the job cap.
//
// `bound < cap` is a ceiling, not a guarantee of attributability at every value
// under it: a bound close to the cap is still reached only after earlier steps
// have spent part of the job budget, so the job cap kills it first and the
// failure is a bare `cancelled` again. It holds here because the real bounds are
// 1-3m against a 10m cap. Summing the bounds against the cap would be the wrong
// stronger rule — bounds are per-step worst cases and every step is expected to
// run, so that sum exceeds any sane cap by design.
function assertTimeouts(steps, cap = policyJobCap()) {
  assert.ok(steps.length > 0, "policy must contain bounded test steps");
  for (const step of steps) {
    const bound = timeoutMinutes(step, 8);
    assert.ok(
      bound > 0,
      `policy test step "${stepName(step)}" must declare a step-level timeout-minutes`,
    );
    assert.ok(
      bound < cap,
      `"${stepName(step)}" bound ${bound}m must sit below the ${cap}m policy job cap`,
    );
  }
}

test("every policy test step has a step-level timeout", () => {
  assertTimeouts(boundedTestSteps());
});

// BLO-31482. Per step, not all-at-once. Stripping every bound in one mutation
// passes as long as *some* step is covered, so it cannot distinguish a guard
// that sees 46 steps from one that sees 43 — which is exactly the gap that let
// three steps sit unbounded under a green gate. Deleting one bound at a time
// and requiring the failure to name that step is what makes coverage per-step.
test("the timeout guard fails when any single test step loses its bound", () => {
  const steps = boundedTestSteps();
  const cap = policyJobCap();
  for (const [index, target] of steps.entries()) {
    const name = stepName(target);
    const mutated = steps.map((step, at) =>
      at === index ? step.replace(new RegExp(`\\n {8}${TIMEOUT_MINUTES}\\n`), "\n") : step,
    );
    assert.throws(
      () => assertTimeouts(mutated, cap),
      new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" must declare`),
      `dropping the bound from "${name}" must fail the guard, naming that step`,
    );
  }
});

test("the timeout guard fails when a test step bound reaches the job cap", () => {
  const cap = policyJobCap();
  const mutated = boundedTestSteps().map((step) =>
    step.replace(new RegExp(`\\n {8}${TIMEOUT_MINUTES}\\n`), `\n        timeout-minutes: ${cap}\n`),
  );
  assert.throws(() => assertTimeouts(mutated, cap), /must sit below the/);
});

// BLO-31482. The widened filter must be a superset of the old one, not a
// replacement for it. Seven in-scope steps are named `Validate *` rather than
// `Test *`, so a name-only rule would silently drop them while the suite stayed
// green — the same class of regression this issue exists to close.
test("widening the filter did not drop any node --test step from scope", () => {
  const covered = new Set(boundedTestSteps().map(stepName));
  for (const step of policySteps()) {
    if (!step.includes("node --test")) continue;
    assert.ok(
      covered.has(stepName(step)),
      `"${stepName(step)}" runs node --test and must stay in the timeout guard's scope`,
    );
  }
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
    const bound = timeoutMinutes(step, 8);
    assert.ok(
      bound >= CONTENTION_SENSITIVE_FLOOR_MINUTES,
      `"${name}" is fork-heavy and measured a p100 above 50% of a one-minute budget, so its bound must stay at or above ${CONTENTION_SENSITIVE_FLOOR_MINUTES}m — found ${bound}m`,
    );
  }
}

// BLO-32670. The floor and the `bound < cap` ceiling are coupled constraints: a
// policy job cap at or below the floor makes them jointly unsatisfiable. Without
// this the collision surfaces as a per-step "must sit below the 3m policy job
// cap" failure, which reads as a problem with whichever step is checked first
// rather than with the pair of rules. #1642 is the PR that sizes that cap, so
// name the collision here instead of letting it land on a step.
test("the contention floor and the policy job cap stay jointly satisfiable", () => {
  const cap = policyJobCap();
  assert.ok(
    CONTENTION_SENSITIVE_FLOOR_MINUTES < cap,
    `the ${CONTENTION_SENSITIVE_FLOOR_MINUTES}m contention floor cannot coexist with a ${cap}m policy job cap — raise the cap, or re-measure the floor and lower it`,
  );
});

test("fork-heavy policy steps keep a bound sized against their measured p100", () => {
  assertContentionFloor(policySteps());
});

test("the contention floor fails when a fork-heavy step is re-tightened to one minute", () => {
  const mutated = policySteps().map((step) =>
    CONTENTION_SENSITIVE_STEPS.includes(stepName(step))
      ? step.replace(new RegExp(`\\n {8}${TIMEOUT_MINUTES}\\n`), "\n        timeout-minutes: 1\n")
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
// it, or the one `node --test` step known to hang is unbounded again, and burns
// the whole job budget instead of failing as itself. The margin (4 min against a
// 73s p100) lives in the workflow comment; the invariant worth gating is only
// that a step bound exists and is under the cap.
test("the chart render step is bounded, and inside its job's budget (BLO-29182)", () => {
  const region = jobRegion("helm_chart");
  const jobCap = timeoutMinutes(region, 4);
  assert.ok(jobCap > 0, "helm_chart must declare a job-level timeout-minutes");
  const step = region
    .split("\n      - name: ")
    .slice(1)
    .find((candidate) => candidate.includes(CHART_SUITE));
  assert.ok(step, `helm_chart must contain the ${CHART_SUITE} step`);
  const stepBound = timeoutMinutes(step, 8);
  assert.ok(stepBound > 0, "the chart render step must declare a step-level timeout-minutes");
  assert.ok(stepBound < jobCap, `step bound ${stepBound}m must sit below the ${jobCap}m job cap`);
});
