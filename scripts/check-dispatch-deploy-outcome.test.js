// PEN-5369. Pins the guard that stops a production deploy dispatch from
// reporting `conclusion: success` after delivering nothing.
//
// Executable rather than render-level, for the reason recorded on
// check-docker-retire-in-flight-lock.test.js: #1636's review showed two
// presence-only assertions passing against mutated code. The full
// needs-result matrix is run against the real script, and the two seams that
// cannot live in the script — the event discriminator and the `always()` —
// are additionally mutation-tested against the workflow text, so gutting
// either fails here by name instead of degrading to a clean verdict.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const workflowPath = path.join(repoRoot, ".github/workflows/docker.yml");
const workflow = readFileSync(workflowPath, "utf8");
const script = path.join(repoRoot, ".github/scripts/assert-dispatch-deploy-outcome.sh");

// The whole matrix defaults to the SHAPE THAT BROKE PRODUCTION — a dispatch
// whose image built and whose deploy never ran. Each case below overrides only
// the field it is about, so a test that forgets a field inherits the defect
// rather than a benign baseline, and cannot pass by accident.
function runGuard(overrides = {}, { scriptPath = script } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "dispatch-deploy-outcome-"));
  const summary = path.join(root, "summary");
  writeFileSync(summary, "");

  const env = {
    BUILD_RESULT: "success",
    GUARD_RESULT: "skipped",
    GUARD_BLOCKED: "",
    FINAL_RESULT: "skipped",
    FINAL_BLOCKED: "",
    DEPLOY_RESULT: "skipped",
    GITHUB_STEP_SUMMARY: summary,
    PATH: process.env.PATH,
    ...overrides,
  };

  const result = spawnSync("bash", [scriptPath], { env, encoding: "utf8" });
  return { ...result, summary: readFileSync(summary, "utf8") };
}

// Writes a copy of the script with `find` replaced by `replace`, so a mutation
// is exercised against the real control flow rather than a paraphrase of it.
function mutatedScript(find, replace) {
  const root = mkdtempSync(path.join(tmpdir(), "dispatch-deploy-outcome-mut-"));
  const copy = path.join(root, "assert-dispatch-deploy-outcome.sh");
  copyFileSync(script, copy);
  const body = readFileSync(copy, "utf8");
  assert.ok(body.includes(find), `mutation anchor not found in script: ${find}`);
  writeFileSync(copy, body.replace(find, replace));
  chmodSync(copy, 0o755);
  return copy;
}

// ---------------------------------------------------------------- the defect

test("a dispatch whose guard was skipped fails the run and names the variable", () => {
  const result = runGuard();

  assert.equal(result.status, 1, `expected failure, got ${result.status}: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /::error::/);
  assert.match(result.stdout, /vars\.PAPERCLIP_CI_DEPLOY/);
  assert.match(result.stdout, /NOTHING was deployed/);
  // The remediation must not read as "flip it back on" — PEN-5369 box 1 is a
  // decision, and its predecessor disable was adopted as deliberate.
  assert.match(result.stdout, /do not simply flip the variable/i);
  assert.match(result.summary, /PEN-5369/);
});

test("the failure is what makes the exporter see an attempt, so it must be a non-zero exit", () => {
  // The drift exporter's classify_deploy_job maps `run failure` + deploy
  // `skipped` to "attempt" and `run success` + deploy `skipped` to "neither".
  // A guard that merely annotated would leave the run green and the gauge at 0,
  // which is precisely the silence this row exists to end.
  const relaxed = mutatedScript("  exit 1\n}", "  exit 0\n}");
  const result = runGuard({}, { scriptPath: relaxed });

  assert.equal(
    result.status,
    0,
    "mutation anchor did not reach the fail() exit; the defect test above may be passing for the wrong reason",
  );
  // ...and the unmutated script must disagree with the mutant.
  assert.equal(runGuard().status, 1);
});

test("an unrecognised skip shape fails closed rather than passing silently", () => {
  // guard succeeded, nothing blocked, build succeeded, yet deploy skipped. No
  // enumerated cause covers this, so a new conjunct on the deploy job's `if:`
  // surfaces loudly the first time it skips a dispatch.
  const result = runGuard({ GUARD_RESULT: "success", FINAL_RESULT: "skipped" });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /no known cause explains it/);
  assert.match(result.stdout, /guard-pending-deploy-final=skipped/);
});

// ------------------------------------------------------------- benign causes

test("a successful deploy reports nothing", () => {
  const result = runGuard({ GUARD_RESULT: "success", FINAL_RESULT: "success", DEPLOY_RESULT: "success" });

  assert.equal(result.status, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /::error::/);
});

test("a deliberate hold on a pending production approval is not a failure", () => {
  for (const blocked of [
    { GUARD_RESULT: "success", GUARD_BLOCKED: "true" },
    { GUARD_RESULT: "success", FINAL_RESULT: "success", FINAL_BLOCKED: "true" },
  ]) {
    const result = runGuard(blocked);
    assert.equal(result.status, 0, `${JSON.stringify(blocked)} -> ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /deliberately held/);
  }
});

test("a deploy skipped because the build died is left to the run conclusion", () => {
  for (const BUILD_RESULT of ["failure", "cancelled", "skipped", "timed_out"]) {
    const result = runGuard({ BUILD_RESULT });
    assert.equal(result.status, 0, `${BUILD_RESULT} -> ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /build-and-push reported/);
  }
});

test("a deploy skipped because a guard itself died is left to the run conclusion", () => {
  for (const override of [
    { GUARD_RESULT: "failure" },
    { GUARD_RESULT: "cancelled" },
    { GUARD_RESULT: "success", FINAL_RESULT: "failure" },
    { GUARD_RESULT: "success", FINAL_RESULT: "cancelled" },
  ]) {
    const result = runGuard(override);
    assert.equal(result.status, 0, `${JSON.stringify(override)} -> ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /a guard reported/);
  }
});

test("a deploy that ran and did not succeed is already visible and is not double-reported", () => {
  for (const DEPLOY_RESULT of ["failure", "cancelled", "timed_out"]) {
    const result = runGuard({ GUARD_RESULT: "success", FINAL_RESULT: "success", DEPLOY_RESULT });
    assert.equal(result.status, 0, `${DEPLOY_RESULT} -> ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /already visible in the run conclusion/);
  }
});

// --------------------------------------------- the two seams in the `if:`

function dispatchOutcomeJobBlock(text) {
  const start = text.indexOf("\n  deploy-dispatch-outcome:");
  assert.notEqual(start, -1, "deploy-dispatch-outcome job is missing from docker.yml");
  return text.slice(start);
}

test("the job is wired to every input its verdict reads", () => {
  const block = dispatchOutcomeJobBlock(workflow);
  for (const dependency of ["build-and-push", "guard-pending-deploy", "guard-pending-deploy-final", "deploy"]) {
    assert.match(
      block,
      new RegExp(`needs:[^\\n]*\\b${dependency.replaceAll("-", "\\-")}\\b`),
      `deploy-dispatch-outcome must declare ${dependency} in needs:, or its result reads empty`,
    );
  }
  // An empty `needs` result reads as the empty string, which the script's
  // fail-closed tail would report as unexplained rather than silently pass —
  // but the verdict would name the wrong cause, so pin the wiring too.
  assert.match(block, /DEPLOY_RESULT: \$\{\{ needs\.deploy\.result \}\}/);
  assert.match(block, /GUARD_RESULT: \$\{\{ needs\.guard-pending-deploy\.result \}\}/);
});

test("PEN-4841: the event discriminator is pinned, so push builds stay silent", () => {
  const block = dispatchOutcomeJobBlock(workflow);
  const condition = block.match(/\n    if: (.+)\n/);
  assert.ok(condition, "deploy-dispatch-outcome has no if:");

  // A `push` build of docker.yml skips `deploy` BY DESIGN. Without this term
  // every push to master would go red, which is the PEN-4841 false positive
  // this row was careful not to reintroduce.
  assert.match(condition[1], /github\.event_name == 'workflow_dispatch'/);
  assert.match(condition[1], /github\.ref == 'refs\/heads\/master'/);

  // Mutation: drop the event term and the assertion above must stop holding.
  const mutated = workflow.replace(
    "if: ${{ always() && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master' }}",
    "if: ${{ always() }}",
  );
  assert.notEqual(mutated, workflow, "mutation anchor did not match the job's if: — this test is vacuous");
  assert.doesNotMatch(
    dispatchOutcomeJobBlock(mutated).match(/\n    if: (.+)\n/)[1],
    /github\.event_name == 'workflow_dispatch'/,
  );
});

test("the job runs on always(), or it is skipped by exactly the thing it watches for", () => {
  const block = dispatchOutcomeJobBlock(workflow);
  const condition = block.match(/\n    if: (.+)\n/)[1];
  // Every case this job catches is one where its needs were SKIPPED. The
  // default success() would skip this job alongside them and reproduce the
  // silence exactly.
  assert.match(condition, /always\(\)/);
});

test("the job runs on a permitted runner pool and holds no write scope", () => {
  const block = dispatchOutcomeJobBlock(workflow);
  assert.match(block, /runs-on: arc-paperclip-light/);
  // It reads its own needs context and calls no API. `contents: read` is only
  // present because a job-level permissions block replaces the workflow-level
  // one, so checkout would otherwise have none.
  const permissions = block.slice(block.indexOf("permissions:"), block.indexOf("steps:"));
  assert.match(permissions, /contents: read/);
  assert.doesNotMatch(permissions, /write/);
});
