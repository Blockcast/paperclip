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

// --- Approval window eviction order (BLO-28483) ---------------------------
//
// The window is bounded and was ordered purely by age, which is backwards under
// the failure it exists to cover: a deploy that fails before its rollout lands
// still consumes a slot forever, so a run of consecutive failures ages out the
// digest actually serving traffic. helm then cannot roll back to the running
// state and a transient upgrade failure becomes a permanently wedged release.
// The fix pins the running digest behind the one being released. These tests
// hold that guarantee, and the control below proves they can actually fail.

const RING_FUNCTION_NAME = "build_approval_ring";
const ringSource = extractShellFunction(RING_FUNCTION_NAME);

// Read the bound out of the script for the same reason the knobs are: a test
// asserting against a hard-coded 3 would go quietly green if the constant and
// the CEL variable it must match were ever moved together.
function shellReadonly(name) {
  const m = script.match(new RegExp(`^readonly ${name}=(\\d+)$`, "m"));
  assert.ok(m, `could not read ${name} out of ${scriptPath}`);
  return Number(m[1]);
}

const MAX_APPROVED_DIGESTS = shellReadonly("MAX_APPROVED_DIGESTS");

// Distinct, well-formed, lowercase-hex digests keyed by a short label.
function digest(label) {
  const hex = label.toString(16).padStart(2, "0");
  return `sha256:${hex.repeat(32).slice(0, 64)}`;
}

// Runs the shipping ring builder. `liveDigest` of "" is the pre-fix behaviour:
// the running digest could not be established, so ordering falls back to age.
function ringFor(newDigest, liveDigest, existing, max = MAX_APPROVED_DIGESTS) {
  const harness = [
    "set -euo pipefail",
    ringSource,
    `printf '%s' "$1" | ${RING_FUNCTION_NAME} "$2" "$3" "$4"`,
  ].join("\n");
  const result = spawnSync(
    "bash",
    ["-c", harness, "harness", existing.join("\n"), newDigest, liveDigest, String(max)],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `ring harness failed: ${result.stderr}`);
  return result.stdout.trim().split("\n").filter(Boolean);
}

test("the digest being released is first and the running digest is pinned right behind it", () => {
  const live = digest(0xaa);
  const ring = ringFor(digest(0x11), live, [digest(0x22), live, digest(0x33)]);
  assert.equal(ring[0], digest(0x11));
  assert.equal(ring[1], live);
  assert.ok(ring.length <= MAX_APPROVED_DIGESTS);
});

test("the running digest survives an unbounded run of deploys that never land", () => {
  const live = digest(0xaa);
  // The live ring as it stood on 2026-09-04: a dead slot holding a digest that
  // was approved and never applied, the running digest, and one older entry.
  let ring = [digest(0x6c), live, digest(0x68)];
  for (let i = 0; i < 25; i += 1) {
    ring = ringFor(digest(0x10 + i), live, ring);
    assert.ok(
      ring.includes(live),
      `the running digest was evicted after ${i + 1} consecutive deploys — rollback is now impossible`,
    );
    assert.ok(ring.length <= MAX_APPROVED_DIGESTS, `window grew to ${ring.length}`);
  }
});

test("CONTROL: without the pin the running digest is evicted in two deploys", () => {
  // Guards the test above from going hollow. This is the pre-fix ordering, and
  // it reproduces the exact arithmetic BLO-28483 was filed on: with one slot
  // already consumed by a digest that never ran, the running digest is two
  // failed deploys away from eviction. If this ever passes, the pin has stopped
  // being load-bearing and the regression test above proves nothing.
  const live = digest(0xaa);
  let ring = [digest(0x6c), live, digest(0x68)];
  ring = ringFor(digest(0x10), "", ring);
  assert.ok(ring.includes(live), "still present after one deploy");
  ring = ringFor(digest(0x11), "", ring);
  assert.ok(!ring.includes(live), "pre-fix ordering must evict the running digest on the second deploy");
});

test("a config-only release reusing the running digest does not duplicate it", () => {
  const live = digest(0xaa);
  const ring = ringFor(live, live, [digest(0x22), digest(0x33)]);
  assert.equal(ring[0], live);
  assert.equal(ring.filter((entry) => entry === live).length, 1);
  assert.ok(ring.length <= MAX_APPROVED_DIGESTS);
});

test("a running digest already in the window is pinned rather than duplicated", () => {
  const live = digest(0xaa);
  const ring = ringFor(digest(0x11), live, [live, digest(0x22)]);
  assert.equal(ring.filter((entry) => entry === live).length, 1);
  assert.equal(ring[1], live);
});

test("an unestablished running digest degrades to newest-first, never to a failure", () => {
  const ring = ringFor(digest(0x11), "", [digest(0x22), digest(0x33), digest(0x44)]);
  assert.deepEqual(ring, [digest(0x11), digest(0x22), digest(0x33)]);
});

test("a malformed running digest is ignored rather than pinned", () => {
  const ring = ringFor(digest(0x11), "not-a-digest", [digest(0x22), digest(0x33)]);
  assert.deepEqual(ring, [digest(0x11), digest(0x22), digest(0x33)]);
});

test("malformed entries are discarded rather than consuming a slot", () => {
  const live = digest(0xaa);
  const ring = ringFor(digest(0x11), live, ["", "  ", "sha256:nope", "garbage", live, digest(0x22)]);
  assert.deepEqual(ring, [digest(0x11), live, digest(0x22)]);
  for (const entry of ring) {
    assert.match(entry, /^sha256:[0-9a-f]{64}$/);
  }
});

test("the window never exceeds the bound the admission policy enforces", () => {
  const live = digest(0xaa);
  const crowded = Array.from({ length: 12 }, (_, index) => digest(0x30 + index));
  const ring = ringFor(digest(0x11), live, [...crowded, live]);
  assert.equal(ring.length, MAX_APPROVED_DIGESTS);
});

test("an empty window yields just the released digest and the running one", () => {
  const live = digest(0xaa);
  assert.deepEqual(ringFor(digest(0x11), live, []), [digest(0x11), live]);
  assert.deepEqual(ringFor(digest(0x11), "", []), [digest(0x11)]);
});

test("a one-slot window still releases, dropping the pin rather than overflowing", () => {
  // Defensive: the pin must never be able to push the window past the bound, so
  // a hypothetical max of 1 keeps only the digest being released.
  assert.deepEqual(ringFor(digest(0x11), digest(0xaa), [digest(0x22)], 1), [digest(0x11)]);
});

// The ring builder being correct proves nothing unless the script actually hands
// it the running digest, so the reader on the other side of that seam is
// exercised too — against a stubbed kubectl, since it is the one part that talks
// to a cluster. Its contract is narrow: name the digest when it can be
// established beyond doubt, otherwise say nothing and succeed. It must never
// fail a release to protect a rollback target.

const READER_FUNCTION_NAME = "live_running_digest";
const readerSource = extractShellFunction(READER_FUNCTION_NAME);

function shellAssign(name) {
  const m = script.match(new RegExp(`^${name}="([^"]+)"$`, "m"));
  assert.ok(m, `could not read ${name} out of ${scriptPath}`);
  return m[1];
}

const IMAGE_REPOSITORY = shellAssign("IMAGE_REPOSITORY");

// `deployment` of null makes the stub exit non-zero, standing in for "no such
// Deployment" or an unreachable apiserver.
function runningDigestFor(deployment) {
  const dir = mkdtempSync(path.join(tmpdir(), "paperclip-live-digest-"));
  const fixture = path.join(dir, "deployment.json");
  writeFileSync(fixture, deployment === null ? "" : JSON.stringify(deployment));
  const harness = [
    "set -euo pipefail",
    `DEPLOY_NAMESPACE=paperclip`,
    `DEPLOYMENT=paperclip-api`,
    `IMAGE_REPOSITORY=${JSON.stringify(IMAGE_REPOSITORY)}`,
    `fake_kubectl() { [[ -s ${JSON.stringify(fixture)} ]] || return 1; cat ${JSON.stringify(fixture)}; }`,
    "deploy_kubectl=(fake_kubectl)",
    readerSource,
    READER_FUNCTION_NAME,
  ].join("\n");
  const result = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
  assert.equal(result.status, 0, `reader must always succeed; stderr: ${result.stderr}`);
  return result.stdout.trim();
}

function deploymentWithImages(...images) {
  return { spec: { template: { spec: { containers: images.map((image) => ({ image })) } } } };
}

test("the running digest is read off a single-container Deployment", () => {
  const live = digest(0xaa);
  assert.equal(runningDigestFor(deploymentWithImages(`${IMAGE_REPOSITORY}@${live}`)), live);
});

test("identical images across containers still name the running digest", () => {
  const live = digest(0xaa);
  const image = `${IMAGE_REPOSITORY}@${live}`;
  assert.equal(runningDigestFor(deploymentWithImages(image, image)), live);
});

test("an unreachable or absent Deployment yields no digest and still succeeds", () => {
  assert.equal(runningDigestFor(null), "");
});

test("a tag-pinned image is not mistaken for a digest", () => {
  assert.equal(runningDigestFor(deploymentWithImages(`${IMAGE_REPOSITORY}:latest`)), "");
});

test("an image from another repository is never pinned", () => {
  const live = digest(0xaa);
  assert.equal(runningDigestFor(deploymentWithImages(`ghcr.io/someone/else@${live}`)), "");
});

test("containers disagreeing on their image yield no digest rather than a guess", () => {
  const images = [`${IMAGE_REPOSITORY}@${digest(0xaa)}`, `${IMAGE_REPOSITORY}@${digest(0xbb)}`];
  assert.equal(runningDigestFor(deploymentWithImages(...images)), "");
});

test("a Deployment with no containers yields no digest", () => {
  assert.equal(runningDigestFor({ spec: { template: { spec: {} } } }), "");
});


