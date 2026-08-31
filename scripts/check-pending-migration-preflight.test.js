import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/docker.yml", import.meta.url), "utf8");
const scriptUrl = new URL("../.github/scripts/check-pending-migrations.sh", import.meta.url);
const script = readFileSync(scriptUrl, "utf8");

function getDeployJobBlock() {
  const marker = "\n  deploy:\n";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, "docker.yml must define a deploy job");
  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
}

test("pending-migration pre-flight runs before helm upgrade", () => {
  const deployJob = getDeployJobBlock();
  const preflight = deployJob.indexOf("- name: pending-migration pre-flight");
  const helm = deployJob.indexOf("- name: helm upgrade");

  assert.notEqual(preflight, -1, "deploy job must run the pending-migration pre-flight");
  assert.notEqual(helm, -1, "deploy job must run helm upgrade");
  // Ordering is the entire value of this gate. Running it after helm upgrade
  // would report the problem only once the 30-minute timeout already burned.
  assert.ok(
    preflight < helm,
    "pending-migration pre-flight must run BEFORE helm upgrade, otherwise the rollout has already stalled by the time it reports",
  );
});

test("pre-flight step invokes the checked-in script", () => {
  const deployJob = getDeployJobBlock();
  assert.ok(
    deployJob.includes(".github/scripts/check-pending-migrations.sh"),
    "the pre-flight step must call .github/scripts/check-pending-migrations.sh",
  );
});

test("pre-flight script is executable", () => {
  const mode = statSync(scriptUrl).mode;
  assert.ok(mode & 0o111, "check-pending-migrations.sh must be executable");
});

test("pre-flight uses the candidate digest, not the running image", () => {
  // The pending set is (migrations in the new image) minus (already applied).
  // Probing the running pod computes the wrong set and passes a doomed deploy.
  assert.ok(script.includes("${IMAGE_REPO}@${DIGEST}"), "the job must run the candidate digest");
  assert.match(script, /DIGEST.*required/, "the script must require DIGEST");
  assert.ok(
    script.includes('[[ "${DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]]'),
    "the script must validate DIGEST is a sha256 digest",
  );
});

test("pre-flight fails closed when the check cannot complete", () => {
  // An inconclusive check must stop the deploy too: starting a rollout blind is
  // precisely the behaviour this gate removes.
  assert.ok(script.includes("INCONCLUSIVE"), "the script must distinguish an inconclusive run");
  const inconclusive = script.indexOf("INCONCLUSIVE");
  const trailing = script.slice(inconclusive);
  assert.match(trailing, /exit 1/, "an inconclusive pre-flight must exit non-zero");
});

test("pre-flight is bounded so it cannot become the stall it prevents", () => {
  assert.match(script, /PREFLIGHT_TIMEOUT_SECONDS/, "the script must bound its wait");
  assert.match(script, /--timeout="\$\{TIMEOUT_SECONDS\}s"/, "the wait must use the bound");
});

test("pre-flight cleans up its job", () => {
  assert.match(script, /trap cleanup EXIT/, "the script must remove its job on exit");
  assert.match(script, /ttlSecondsAfterFinished/, "the job must also self-expire");
});

test("pre-flight always surfaces the remediation output", () => {
  // The remediation SQL is the deliverable; logs must print on success and
  // failure alike, not only in the failure branch.
  const logsAt = script.indexOf("kubectl -n \"${NS}\" logs");
  const passAt = script.indexOf("pending-migration pre-flight: PASSED");
  assert.notEqual(logsAt, -1, "the script must print the job logs");
  assert.ok(logsAt < passAt, "logs must be printed before the pass/fail branch, so both paths show them");
});
