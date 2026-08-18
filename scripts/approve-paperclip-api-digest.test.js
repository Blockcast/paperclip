// The approval script's admissibility probe is the step that failed three
// consecutive production deploys (2026-08-14/-16/-17) and then passed unchanged
// on 08-18 — an informer-convergence race, not a rejected manifest (BLO-28471).
// Its backoff is therefore load-bearing, and its one knob is documented to the
// operator as "raise PAPERCLIP_APPROVAL_PROBE_ATTEMPTS and retry" at the exact
// moment a release is wedged. Both halves are tested here: that raising the knob
// stays arithmetically sound, and that a fat-fingered value fails fast.
//
// The backoff is evaluated by extracting the real function out of the shipping
// script and sourcing it, so a rename or a rewrite fails this test rather than
// silently leaving it asserting against a copy.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const scriptPath = path.join(repoRoot, "scripts/approve-paperclip-api-digest.sh");
const script = readFileSync(scriptPath, "utf8");

const FUNCTION_NAME = "probe_backoff_seconds";

function extractShellFunction(name) {
  const lines = script.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${name}() {`));
  assert.notEqual(start, -1, `${name}() not found in ${scriptPath} — was it renamed or removed?`);
  const end = lines.indexOf("}", start);
  assert.notEqual(end, -1, `${name}() has no closing brace`);
  return lines.slice(start, end + 1).join("\n");
}

const backoffSource = extractShellFunction(FUNCTION_NAME);

// Returns the delay the shipping function yields for each attempt, under the
// given ceiling. One bash invocation per call, not per attempt.
function delaysFor(attempts, maxSleepSeconds = 8) {
  const harness = [
    "set -euo pipefail",
    `PROBE_MAX_SLEEP_SECONDS=${maxSleepSeconds}`,
    backoffSource,
    `for attempt in ${attempts.join(" ")}; do`,
    `  ${FUNCTION_NAME} "$attempt"`,
    '  printf "\\n"',
    "done",
  ].join("\n");
  const result = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
  assert.equal(result.status, 0, `backoff harness failed: ${result.stderr}`);
  return result.stdout.trim().split("\n").map(Number);
}

function range(from, to) {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

test("backoff follows the documented 1,1,2,2,4,4,8,8 ramp and holds at the ceiling", () => {
  assert.deepEqual(delaysFor(range(1, 12)), [1, 1, 2, 2, 4, 4, 8, 8, 8, 8, 8, 8]);
});

test("the default 40-attempt window spends the sleep budget the comment claims", () => {
  const total = delaysFor(range(1, 40)).reduce((sum, delay) => sum + delay, 0);
  assert.equal(total, 286);
});

test("a raised ceiling is honoured and never exceeded", () => {
  assert.deepEqual(delaysFor(range(1, 10), 30), [1, 1, 2, 2, 4, 4, 8, 8, 16, 16]);
  for (const delay of delaysFor(range(1, 64), 30)) {
    assert.ok(delay <= 30, `delay ${delay} exceeded the 30s ceiling`);
  }
});

// The regression this file exists for. `1 << 63` is INT64_MIN in bash's signed
// arithmetic, so an unclamped exponent handed `sleep` a negative delay at
// attempt 127 — aborting mid-probe under `set -euo pipefail` with the in-flight
// approval lock still held, which forces a manual
// PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT recovery. Past that the shift wrapped and
// delays collapsed back to 1s, shrinking the backoff in precisely the scenario
// where the operator had widened it.
test("every attempt past the overflow boundary stays a sane, non-shrinking delay", () => {
  const attempts = range(1, 200);
  const delays = delaysFor(attempts);
  delays.forEach((delay, index) => {
    const attempt = attempts[index];
    assert.ok(Number.isInteger(delay), `attempt ${attempt} produced a non-integer delay ${delay}`);
    assert.ok(delay >= 1, `attempt ${attempt} produced delay ${delay}; sleep rejects it`);
    assert.ok(delay <= 8, `attempt ${attempt} produced delay ${delay}, above the ceiling`);
    if (index > 0) {
      assert.ok(
        delay >= delays[index - 1],
        `backoff shrank at attempt ${attempt}: ${delays[index - 1]} -> ${delay}`,
      );
    }
  });
});

test("an absurd attempt number still yields a usable delay", () => {
  assert.deepEqual(delaysFor([1_000, 100_000]), [8, 8]);
});

// The knobs are validated alongside the other operator-facing env, before the
// in-flight lock is taken, so a typo cannot strand the ring. These runs stop at
// the missing PAPERCLIP_DEPLOY_KUBECONFIG check and never contact a cluster.
function runWithKnobs(env) {
  const planned = path.join(mkdtempSync(path.join(tmpdir(), "approve-knobs-")), "planned.yaml");
  writeFileSync(planned, "apiVersion: apps/v1\nkind: Deployment\n");
  return spawnSync("bash", [scriptPath, `sha256:${"0".repeat(64)}`, planned], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
}

test("a non-numeric probe knob is rejected before the approval ring is touched", () => {
  for (const knob of [
    "PAPERCLIP_APPROVAL_PROBE_ATTEMPTS",
    "PAPERCLIP_APPROVAL_PROBE_MAX_SLEEP_SECONDS",
  ]) {
    for (const value of ["0", "-1", "8s", "eight", "1.5", " 4"]) {
      const result = runWithKnobs({ [knob]: value });
      assert.equal(result.status, 2, `${knob}='${value}' should exit 2, got ${result.status}`);
      assert.match(
        result.stderr,
        new RegExp(`${knob}=.*is not a positive integer`),
        `${knob}='${value}' should name the offending knob, got: ${result.stderr}`,
      );
    }
  }
});

// `${VAR:-default}` treats an explicitly-empty value as unset, and that is the
// behaviour we want: a workflow `env:` whose expression resolves to "" must get
// the default rather than failing the deploy. Pinned so a later tightening of
// the regex to reject empty does not quietly break every run that leaves the
// knob unset.
test("an empty probe knob falls through to the default rather than failing", () => {
  const result = runWithKnobs({
    PAPERCLIP_APPROVAL_PROBE_ATTEMPTS: "",
    PAPERCLIP_APPROVAL_PROBE_MAX_SLEEP_SECONDS: "",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /PAPERCLIP_DEPLOY_KUBECONFIG must name the deploy credential/);
  assert.doesNotMatch(result.stderr, /is not a positive integer/);
});

test("valid knobs pass validation and the script proceeds to the deploy credential", () => {
  const result = runWithKnobs({
    PAPERCLIP_APPROVAL_PROBE_ATTEMPTS: "120",
    PAPERCLIP_APPROVAL_PROBE_MAX_SLEEP_SECONDS: "30",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /PAPERCLIP_DEPLOY_KUBECONFIG must name the deploy credential/);
  assert.doesNotMatch(result.stderr, /is not a positive integer/);
});
