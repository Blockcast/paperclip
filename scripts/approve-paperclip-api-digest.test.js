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
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// fileURLToPath, not URL.pathname: pathname does not percent-decode, so a
// checkout path containing a space or non-ASCII character would resolve wrong.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
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

// The defaults are READ OUT OF THE SCRIPT, not hard-coded. The whole point of
// extracting the function is that a rename fails here rather than silently
// testing a stale copy — but that guarantee was hollow while the two numbers the
// budget assertion depends on were literals. Changing the script's ceiling to 4
// would have left `total === 286` passing green while the real budget became
// 158s and the script's own "40 attempts ~= 286s" comment became false: a silent
// divergence in the exact quantity this fix exists to control.
function shellDefault(knob) {
  const m = script.match(new RegExp(`\\$\\{PAPERCLIP_APPROVAL_${knob}:-(\\d+)\\}`));
  assert.ok(m, `could not read the PAPERCLIP_APPROVAL_${knob} default out of ${scriptPath}`);
  return Number(m[1]);
}

// Likewise the upper bounds, so the rejection tests cannot drift from the script.
function shellLimit(name) {
  const m = script.match(new RegExp(`^${name}=(\\d+)$`, "m"));
  assert.ok(m, `could not read ${name} out of ${scriptPath}`);
  return Number(m[1]);
}

const DEFAULT_ATTEMPTS = shellDefault("PROBE_ATTEMPTS");
const DEFAULT_MAX_SLEEP = shellDefault("PROBE_MAX_SLEEP_SECONDS");
const ATTEMPTS_LIMIT = shellLimit("PROBE_ATTEMPTS_LIMIT");
const MAX_SLEEP_LIMIT = shellLimit("PROBE_MAX_SLEEP_SECONDS_LIMIT");

const backoffSource = extractShellFunction(FUNCTION_NAME);

// Returns the delay the shipping function yields for each attempt, under the
// given ceiling. One bash invocation per call, not per attempt.
function delaysFor(attempts, maxSleepSeconds = DEFAULT_MAX_SLEEP) {
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

// The budget prose wraps across several `#` lines, so assertions about it match
// a normalised form rather than a brittle single-line regex.
const commentText = script
  .split("\n")
  .filter((line) => line.trimStart().startsWith("#"))
  .map((line) => line.trimStart().replace(/^#\s?/, ""))
  .join(" ")
  .replace(/\s+/g, " ");

test("the script documents BOTH sleep quantities, and both match the arithmetic", () => {
  // Two different numbers live here and conflating them is the exact defect this
  // guards: probe_backoff_seconds summed over every attempt, versus what the
  // loop actually sleeps — the final attempt does not sleep, so the loop spends
  // one whole ceiling less. The prior version of this test asserted only the
  // former while the comment claimed it was the latter, so the suite actively
  // defended a figure that was wrong by exactly PROBE_MAX_SLEEP_SECONDS.
  assert.equal(DEFAULT_ATTEMPTS, 40, "default attempt count moved; update the script comment too");
  assert.equal(DEFAULT_MAX_SLEEP, 8, "default ceiling moved; update the script comment too");

  const sum = (delays) => delays.reduce((total, delay) => total + delay, 0);
  const functionTotal = sum(delaysFor(range(1, DEFAULT_ATTEMPTS)));
  const loopSleeps = sum(delaysFor(range(1, DEFAULT_ATTEMPTS - 1)));

  assert.equal(functionTotal, 286);
  assert.equal(loopSleeps, 278);
  assert.equal(
    functionTotal - loopSleeps,
    DEFAULT_MAX_SLEEP,
    "the skipped final sleep should be exactly one ceiling",
  );

  // Expected prose is built FROM the computed values, so the comment cannot
  // drift away from the arithmetic in either direction.
  assert.match(
    commentText,
    new RegExp(`over ${DEFAULT_ATTEMPTS} attempts totals ${functionTotal}s`),
    `the script comment no longer states the function's ${functionTotal}s total`,
  );
  assert.match(
    commentText,
    new RegExp(`exhausted window spends ${loopSleeps}s sleeping`),
    `the script comment no longer states the loop's real ${loopSleeps}s budget`,
  );
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

// Shape validation alone left the same class of hazard the clamp closed:
// PAPERCLIP_APPROVAL_PROBE_ATTEMPTS=4000 is one stray zero on the default 40 and
// buys ~8.9h of probing while the in-flight approval lock is held. Only CI has a
// deadline; the hand-invoked path documented in the runbook has none.
//
// The two 20-digit cases are the reason the guard checks digit WIDTH before
// magnitude. `(( ))` is signed 64-bit: 2^64 + 40 wraps to exactly 40, so a bare
// `(( value > limit ))` returns false and passes it through to
// `seq 1 "$PROBE_ATTEMPTS"`, which iterates on the unwrapped literal
// essentially forever with the lock held. 99999999999999999999 was caught
// before only by luck — it wraps to 7766279631452241919, still above the limit.
test("an out-of-range probe knob is rejected before the approval ring is touched", () => {
  const cases = [
    ["PAPERCLIP_APPROVAL_PROBE_ATTEMPTS", String(ATTEMPTS_LIMIT + 1)],
    ["PAPERCLIP_APPROVAL_PROBE_ATTEMPTS", "4000"],
    ["PAPERCLIP_APPROVAL_PROBE_ATTEMPTS", "18446744073709551656"],
    ["PAPERCLIP_APPROVAL_PROBE_ATTEMPTS", "99999999999999999999"],
    ["PAPERCLIP_APPROVAL_PROBE_MAX_SLEEP_SECONDS", String(MAX_SLEEP_LIMIT + 1)],
    ["PAPERCLIP_APPROVAL_PROBE_MAX_SLEEP_SECONDS", "86400"],
    ["PAPERCLIP_APPROVAL_PROBE_MAX_SLEEP_SECONDS", "18446744073709555200"],
  ];
  for (const [knob, value] of cases) {
    const result = runWithKnobs({ [knob]: value });
    assert.equal(result.status, 2, `${knob}='${value}' should exit 2, got ${result.status}`);
    assert.match(
      result.stderr,
      new RegExp(`${knob}=.*exceeds the \\d+ maximum`),
      `${knob}='${value}' should name the knob and its bound, got: ${result.stderr}`,
    );
  }
});

// The bound is a fat-finger guard, not a policy: a deliberate widening well past
// the default must still be accepted, right up to the limit.
test("a deliberately widened knob at the limit is still accepted", () => {
  const result = runWithKnobs({
    PAPERCLIP_APPROVAL_PROBE_ATTEMPTS: String(ATTEMPTS_LIMIT),
    PAPERCLIP_APPROVAL_PROBE_MAX_SLEEP_SECONDS: String(MAX_SLEEP_LIMIT),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /PAPERCLIP_DEPLOY_KUBECONFIG must name the deploy credential/);
  assert.doesNotMatch(result.stderr, /is not a positive integer|exceeds the/);
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

// --- in-flight lock owner handoff (BLO-31598) -------------------------------
//
// Production deploys wedged when an approval succeeded and the job then died at
// the pending-migration pre-flight, before helm touched the cluster. The lock
// that approval took can never self-clear — its rollout never happened — and the
// owner id needed to retire it existed only as prose on stdout, so no workflow
// step could name it. emit_lock_owner is the handoff that closes that gap.
//
// The safety property is the one worth guarding: it must stay SILENT for a lock
// adopted from an earlier attempt, because that rollout may still be running and
// retiring its lock would reopen the approval ring underneath it.
const OWNER_FN = "emit_lock_owner";
const emitOwnerSource = extractShellFunction(OWNER_FN);

// Runs the real shipping function against a scratch path and reports what the
// caller would observe: whether a file appeared, its contents, and its mode.
function emitOwner({ ours, outPathSet = true, ownerId = "a".repeat(64) }) {
  const dir = mkdtempSync(path.join(tmpdir(), "paperclip-lock-owner-"));
  const outPath = path.join(dir, "lock-owner.txt");
  const harness = [
    "set -euo pipefail",
    `LOCK_OWNER_ID=${ownerId}`,
    `lock_owner_is_ours=${ours ? "yes" : '""'}`,
    outPathSet ? `PAPERCLIP_APPROVAL_LOCK_OWNER_OUT=${JSON.stringify(outPath)}` : "",
    emitOwnerSource,
    OWNER_FN,
    // Report mode via stat so the umask is asserted, not assumed.
    `if [ -e ${JSON.stringify(outPath)} ]; then`,
    `  printf 'WROTE %s %s' "$(cat ${JSON.stringify(outPath)})" "$(stat -c %a ${JSON.stringify(outPath)})"`,
    "else",
    "  printf 'NOFILE'",
    "fi",
  ].filter(Boolean).join("\n");
  const result = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
  assert.equal(result.status, 0, `emit_lock_owner harness failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("a lock this invocation minted hands its owner to the workflow", () => {
  const ownerId = "b".repeat(64);
  assert.equal(emitOwner({ ours: true, ownerId }), `WROTE ${ownerId} 600`);
});

// The safety-critical case. An adopted lock belongs to a rollout that may still
// be live; naming its owner would invite a caller to abandon it.
test("a lock adopted from an earlier attempt is never named", () => {
  assert.equal(emitOwner({ ours: false }), "NOFILE");
});

test("the handoff is opt-in and silently absent when unrequested", () => {
  assert.equal(emitOwner({ ours: true, outPathSet: false }), "NOFILE");
});

// The flag is only meaningful if it tracks the script's own provenance split.
// These assert against the shipping source, so deleting either assignment — and
// thereby letting an adopted lock be reported as ours — fails here.
test("ownership is cleared on exactly the branches that inherit or lose the lock", () => {
  const adopted = script.slice(script.indexOf("lock_preserve_on_failure=yes"));
  assert.match(
    adopted.slice(0, 200),
    /lock_owner_is_ours=""/,
    "the adopted-lock branch must disown the lock, or an inherited lock can be abandoned",
  );
  const conflict = script.slice(script.indexOf("# A conflict proves this write did not land"));
  assert.match(
    conflict.slice(0, 400),
    /lock_owner_is_ours=""/,
    "a conflicting write did not land, so no lock with our owner exists",
  );
});

// Emitting before the write would name a lock that does not exist if the replace
// then fails, sending a cleanup step to abandon another process's transaction.
//
// Located by indentation rather than by the exact call text: the call is now
// `||`-guarded (see the next test), and pinning the bare statement would make
// adding that guard fail this test for the wrong reason.
const emitCallLineIndex = script
  .split("\n")
  .findIndex((line) => new RegExp(`^ {4}${OWNER_FN}\\b`).test(line));

test("the owner is emitted only after the ring write actually lands", () => {
  assert.notEqual(emitCallLineIndex, -1, `${OWNER_FN} is never called from the rotate loop`);
  const lines = script.split("\n");
  const rotatedLineIndex = lines.findIndex((line) => line.includes("rotated=yes"));
  assert.notEqual(rotatedLineIndex, -1, "rotated=yes not found in the rotate loop");
  assert.ok(
    emitCallLineIndex > rotatedLineIndex,
    `${OWNER_FN} must be called after the successful kubectl replace, not before it`,
  );
});

// The call sits five lines after the ring rotation, so under `set -e` a bare
// invocation turns any write failure into an abort with the ring rotated and the
// lock held — reproducing the exact window this handoff closes. Up-front
// validation removes the foreseeable causes; this guard covers the rest.
test("a failed handoff cannot abort the run after the ring has rotated", () => {
  assert.notEqual(emitCallLineIndex, -1, `${OWNER_FN} is never called from the rotate loop`);
  const statement = script.split("\n").slice(emitCallLineIndex, emitCallLineIndex + 2).join("\n");
  assert.match(
    statement,
    /\|\|/,
    `${OWNER_FN} must be \`||\`-guarded at the call site, or set -e aborts with the lock held`,
  );
});

// --- handoff path validation ------------------------------------------------
//
// Ally flagged this on #1638: the handoff path was the only operator-facing
// value in the script with no up-front validation, in a file that states the
// opposite convention outright ("Validated here, with the other operator-facing
// env, so a typo fails before the ring is touched"). The failure it produced was
// not a wedge — cleanup_on_exit still retires the lock — but it cost a deploy and
// aborted at a point in the script that reads like success.
function runWithOwnerOut(outPath) {
  return runWithKnobs({ PAPERCLIP_APPROVAL_LOCK_OWNER_OUT: outPath });
}

test("an unwritable handoff path is rejected before the approval ring is touched", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperclip-owner-out-"));
  const cases = [
    // The realistic one: a workflow that has not created the directory yet.
    [path.join(dir, "missing-dir", "lock-owner.txt"), /is not a directory/],
    // A path that names the directory itself.
    [dir, /is a directory, not a file/],
  ];
  for (const [outPath, expected] of cases) {
    const result = runWithOwnerOut(outPath);
    assert.equal(result.status, 2, `${outPath} should exit 2, got ${result.status}`);
    assert.match(result.stderr, /PAPERCLIP_APPROVAL_LOCK_OWNER_OUT=/);
    assert.match(result.stderr, expected, `got: ${result.stderr}`);
  }
});

// The whole safety property of the handoff is that an ABSENT file means "this
// invocation has no lock it is entitled to abandon". Validating by creating the
// target would hand a consumer a path that exists with no owner in it, so the
// probe must not leave the target behind.
test("validating the handoff path does not create the target file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperclip-owner-out-"));
  const outPath = path.join(dir, "lock-owner.txt");
  const result = runWithOwnerOut(outPath);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /PAPERCLIP_DEPLOY_KUBECONFIG must name the deploy credential/);
  assert.doesNotMatch(result.stderr, /PAPERCLIP_APPROVAL_LOCK_OWNER_OUT/);
  assert.equal(existsSync(outPath), false, "validation must not pre-create the handoff target");
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.includes("probe")),
    [],
    "the writability probe must clean up after itself",
  );
});

test("an unset handoff path skips validation entirely", () => {
  const result = runWithKnobs({});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /PAPERCLIP_DEPLOY_KUBECONFIG must name the deploy credential/);
  assert.doesNotMatch(result.stderr, /PAPERCLIP_APPROVAL_LOCK_OWNER_OUT/);
});
