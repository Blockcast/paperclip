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
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

// The reader's health gate lives in a jq block, not in the function body, so it
// has to be lifted out of the script and injected alongside it — same reason as
// everything else here: a rewrite of the predicate must fail this test rather
// than leave it asserting against a copy that no longer ships.
function extractJqBlock(name) {
  const m = script.match(new RegExp(`^# BEGIN ${name}$\\n([\\s\\S]*?)^# END ${name}$`, "m"));
  assert.ok(m, `could not read the ${name} jq block out of ${scriptPath}`);
  return m[1];
}

const SERVING_JQ = extractJqBlock("ROLLOUT_SERVING_JQ");

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
    "read -r -d '' ROLLOUT_SERVING_JQ <<'SERVING_JQ' || true",
    SERVING_JQ.replace(/\n$/, ""),
    "SERVING_JQ",
    `fake_kubectl() { [[ -s ${JSON.stringify(fixture)} ]] || return 1; cat ${JSON.stringify(fixture)}; }`,
    "deploy_kubectl=(fake_kubectl)",
    readerSource,
    READER_FUNCTION_NAME,
  ].join("\n");
  const result = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
  assert.equal(result.status, 0, `reader must always succeed; stderr: ${result.stderr}`);
  return result.stdout.trim();
}

// A Deployment whose rollout has fully landed. Fixtures default to that shape so
// a case which only cares about the image does not have to restate six status
// fields, and `status` overrides merge over the healthy defaults.
//
// `unavailableReplicas` is deliberately ABSENT from the healthy default, because
// that is the shape the apiserver actually returns: the live paperclip-api
// Deployment omits the field entirely while healthy (observed 2026-09-04 at
// generation 560, replicas 2/2/2). The predicate's `// 0` default is what makes
// that read as "none unavailable" rather than as missing data, so the common
// fixture exercises that path rather than a shape production never produces.
function deploymentWith({ images = [], replicas = 2, generation = 7, status = {} } = {}) {
  return {
    metadata: { generation },
    spec: {
      replicas,
      template: { spec: { containers: images.map((image) => ({ image })) } },
    },
    status: {
      observedGeneration: generation,
      updatedReplicas: replicas,
      readyReplicas: replicas,
      availableReplicas: replicas,
      ...status,
    },
  };
}

function deploymentWithImages(...images) {
  return deploymentWith({ images });
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
  // Built healthy on purpose: with no status the health gate would refuse this
  // anyway, and the test would pass without ever reaching the container check.
  assert.equal(runningDigestFor(deploymentWith({ images: [] })), "");
});

// The pod template records what was ASKED for. Nothing reverts spec.template
// after a failed rollout, so believing it on its own pins a digest that never
// carried traffic -- burning the reserved slot and letting the last healthy
// digest age out, which is the BLO-28483 wedge reached from the other side.
// These cases are the reason the reader gates on rollout status at all.

test("a rollout applied but never made ready is not pinned as the running digest", () => {
  const applied = digest(0xbb);
  assert.equal(
    runningDigestFor(
      deploymentWith({
        images: [`${IMAGE_REPOSITORY}@${applied}`],
        status: { readyReplicas: 0, availableReplicas: 0, unavailableReplicas: 2 },
      }),
    ),
    "",
  );
});

test("a rollout still in flight yields no digest rather than a half-rolled one", () => {
  // maxSurge brings a new pod up before the old one leaves, so the template
  // already names the new digest while the old one is still serving. Neither is
  // unambiguously the running digest, so name neither.
  assert.equal(
    runningDigestFor(
      deploymentWith({
        images: [`${IMAGE_REPOSITORY}@${digest(0xcc)}`],
        status: { updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 },
      }),
    ),
    "",
  );
});

test("a pod template the controller has not observed yet is not believed", () => {
  // spec.template was just patched, so status still describes the previous one.
  assert.equal(
    runningDigestFor(
      deploymentWith({
        images: [`${IMAGE_REPOSITORY}@${digest(0xdd)}`],
        generation: 8,
        status: { observedGeneration: 7 },
      }),
    ),
    "",
  );
});

test("a Deployment scaled to zero has nothing serving and yields no digest", () => {
  assert.equal(
    runningDigestFor(deploymentWith({ images: [`${IMAGE_REPOSITORY}@${digest(0xee)}`], replicas: 0 })),
    "",
  );
});

test("a landed rollout that omits unavailableReplicas is still read as serving", () => {
  // The shape production actually returns; see deploymentWith.
  const live = digest(0xaa);
  const deployment = deploymentWith({ images: [`${IMAGE_REPOSITORY}@${live}`] });
  assert.ok(
    !Object.hasOwn(deployment.status, "unavailableReplicas"),
    "this test is only meaningful while the healthy fixture omits unavailableReplicas",
  );
  assert.equal(runningDigestFor(deployment), live);
});

// Split a jq predicate block into the condition lines of its top-level
// conjunction. ROLLOUT_COMPLETE_JQ opens with a `def advanced: … ;` helper whose
// body is control flow rather than conditions; jq definitions end in `;` and
// condition lines never do, so the conjunction is everything after the last one.
function jqConditions(block) {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const endOfDefs = lines.reduce((at, line, index) => (line.endsWith(";") ? index : at), -1);
  return lines.slice(endOfDefs + 1).map((line) => line.replace(/ and$/, ""));
}

// The clauses ROLLOUT_COMPLETE_JQ carries that ROLLOUT_SERVING_JQ deliberately
// does not. Each establishes that MY plan's rollout landed, not that whatever
// template is written is the one serving: the expected image and its structural
// precondition, the rollout marker, and the generation advance. Everything else
// in the completion predicate is a rollout-health condition, and the drift test
// below requires it to appear in the serving predicate too.
const LOCK_IDENTITY_CONDITIONS = [
  '(.spec.template.spec.containers | type == "array" and length > 0)',
  "(.spec.template.spec.containers | all(.image == $image))",
  '(.spec.template.metadata.annotations[$marker_key] // "") == $marker',
  "advanced",
];

// The reader's health gate and the in-flight lock's completion predicate must
// agree on what "this rollout has landed" means. They are separate jq programs
// because they answer different questions -- the lock also proves plan identity
// and generation advance -- so nothing but this test stops one from being
// tightened while the other silently keeps the old reading.
//
// The comparison is set equality over the health half, in BOTH directions. The
// reverse direction is the load-bearing one: a health condition added to the
// completion predicate alone would silently make the reader the weaker of the
// two definitions, so it would pin a digest the lock itself would not call
// landed -- the exact failure this gate was introduced to close, reintroduced
// by drift rather than by code.
test("the serving predicate does not drift from the completion predicate", () => {
  const serving = jqConditions(SERVING_JQ);
  const complete = jqConditions(extractJqBlock("ROLLOUT_COMPLETE_JQ"));

  assert.ok(
    serving.length >= 6,
    `expected the serving predicate to carry the rollout-health conditions, got ${serving.length}`,
  );

  // Keep the classification honest: a lock-only clause that no longer exists
  // must not sit here silently exempting a condition name from the comparison.
  for (const condition of LOCK_IDENTITY_CONDITIONS) {
    assert.ok(
      complete.includes(condition),
      `LOCK_IDENTITY_CONDITIONS in this test lists \`${condition}\` as lock-only, but ` +
        "ROLLOUT_COMPLETE_JQ no longer carries it — update the classification",
    );
  }

  const completeHealth = complete.filter((condition) => !LOCK_IDENTITY_CONDITIONS.includes(condition));

  for (const condition of serving) {
    assert.ok(
      completeHealth.includes(condition),
      `ROLLOUT_SERVING_JQ requires \`${condition}\` but ROLLOUT_COMPLETE_JQ no longer does — ` +
        "the two definitions of a landed rollout have drifted apart",
    );
  }

  for (const condition of completeHealth) {
    assert.ok(
      serving.includes(condition),
      `ROLLOUT_COMPLETE_JQ requires \`${condition}\` but ROLLOUT_SERVING_JQ does not — ` +
        "the reader would pin a digest the lock's own predicate would not call landed. " +
        "Add it to ROLLOUT_SERVING_JQ, or to LOCK_IDENTITY_CONDITIONS in this test if it " +
        "proves plan identity rather than rollout health",
    );
  }
});

const FORMATTER_FUNCTION_NAME = "format_digest_list";
const formatterSource = extractShellFunction(FORMATTER_FUNCTION_NAME);

// The list reaches the formatter exactly as it does in the script: through a
// command substitution (which strips trailing newlines) and then double-quoted,
// so a multi-line window is one argument rather than several.
function formatDigestList(list) {
  const dir = mkdtempSync(path.join(tmpdir(), "paperclip-digest-list-"));
  const fixture = path.join(dir, "window.txt");
  writeFileSync(fixture, list);
  const harness = [
    "set -euo pipefail",
    formatterSource,
    `window="$(cat ${JSON.stringify(fixture)})"`,
    `${FORMATTER_FUNCTION_NAME} "$window"`,
  ].join("\n");
  const result = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
  assert.equal(result.status, 0, `formatter must always succeed; stderr: ${result.stderr}`);
  return result.stdout;
}

// The read-back guards print this on their failure paths, where the contents are
// the actionable part. An empty window must not render as a blank line, or the
// "did not persist" report would say nothing at all about what the cluster holds.
test("the digest-list formatter indents each entry and marks an empty window", () => {
  const a = digest(0xaa);
  const b = digest(0xbb);

  assert.equal(formatDigestList(`${a}\n${b}`), `  - ${a}\n  - ${b}\n`);
  assert.equal(formatDigestList(a), `  - ${a}\n`);
  assert.equal(formatDigestList(""), "  (none)\n");
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
    `if [ -e ${JSON.stringify(outPath)} ]; then`,
    `  printf 'WROTE %s' "$(cat ${JSON.stringify(outPath)})"`,
    "else",
    "  printf 'NOFILE'",
    "fi",
  ].filter(Boolean).join("\n");
  const result = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
  assert.equal(result.status, 0, `emit_lock_owner harness failed: ${result.stderr}`);
  const observed = result.stdout.trim();
  // Mode is read here rather than via `stat -c %a`, which is GNU-only syntax and
  // fails the harness outright on BSD/macOS — asserting the umask, not the
  // platform's stat flags.
  if (observed === "NOFILE") return observed;
  return `${observed} ${(statSync(outPath).mode & 0o777).toString(8)}`;
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
// Located by indentation rather than by the exact call text, so this ordering
// assertion survives a change to the call's FORM (a guard, a redirect) and fails
// only when the call actually MOVES, which is the property it exists to pin.
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

// The emit call is deliberately BARE, so under `set -e` a write failure five
// lines after the rotation aborts the run. That is only correct because the
// abort is self-healing: the minted branch armed lock_cleanup_armed, so
// cleanup_on_exit retires the lock rather than stranding it.
//
// Ally flagged the earlier `||` guard on #1638 because the comment justifying it
// asserted the opposite — that aborting there holds the lock — which is false and
// which its own next sentence contradicted. So this executes the real
// cleanup_on_exit against the real flag values instead of reading the source:
// a rationale that claims self-healing is worth nothing if the cleanup it names
// stops firing, and only running it catches that.
const cleanupSource = extractShellFunction("cleanup_on_exit");

function runCleanup({ armed, preserve, status, releaseFails = false }) {
  const dir = mkdtempSync(path.join(tmpdir(), "paperclip-cleanup-"));
  const harness = [
    "set -uo pipefail",
    `lock_cleanup_armed=${armed ? "yes" : '""'}`,
    `lock_preserve_on_failure=${preserve ? "yes" : '""'}`,
    "DIGEST=sha256:feedface",
    // cleanup_on_exit rm -f's these; point them at unused paths in a scratch dir.
    ...["replace_err", "nonce_err", "server_plan_err", "probe_attempts_log", "release_err"].map(
      (name) => `${name}=${JSON.stringify(path.join(dir, name))}`,
    ),
    // The failed-retirement branch names the cluster coordinates of the owner
    // annotation, so the harness has to carry them or `set -u` aborts the
    // cleanup before it reaches the branch under test. Real values, not
    // placeholders: the assertion below reads the command it prints.
    "NAMESPACE=paperclip-release-approvals",
    "CONFIGMAP=paperclip-api-approved-images",
    "LOCK_OWNER_ANNOTATION=paperclip.blockcast.net/approval-in-flight-owner",
    // Stubbed so the test observes the DECISION to retire, with no cluster.
    releaseFails
      ? "release_in_flight_lock() { return 1; }"
      : 'release_in_flight_lock() { echo "RELEASED" >&2; return 0; }',
    cleanupSource,
    // cleanup_on_exit reads $?, so set it exactly as the trap would.
    `( exit ${status} )`,
    "cleanup_on_exit",
  ].join("\n");
  const result = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
  return { status: result.status, released: /RELEASED/.test(result.stderr), stderr: result.stderr };
}

test("aborting after the ring rotated retires the lock this run minted", () => {
  const result = runCleanup({ armed: true, preserve: false, status: 1 });
  assert.equal(result.released, true, "a minted lock must be retired on failure, not stranded");
  assert.equal(result.status, 1, "cleanup must preserve the failing exit status");
  assert.match(result.stderr, /Retired this approval's in-flight lock/);
});

// The other half of the safety split: an adopted lock belongs to a rollout that
// may still be live, so failure must leave it alone.
test("aborting after adopting an earlier attempt's lock leaves it alone", () => {
  const result = runCleanup({ armed: false, preserve: true, status: 1 });
  assert.equal(result.released, false, "an inherited lock must survive this run's failure");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Preserved the adopted in-flight lock/);
});

// Success deliberately leaves the lock live for the next release to retire after
// observing this plan marker roll out.
test("a successful run leaves its lock live for the next release", () => {
  const result = runCleanup({ armed: true, preserve: false, status: 0 });
  assert.equal(result.released, false, "success must not retire the lock it is handing forward");
  assert.equal(result.status, 0);
});

// The cleanup above only runs if the emit failure actually propagates. Reading
// the call site for an absent `||` would be the same presence-assertion Ally
// showed passing on mutated code, so run the REAL call statement under real
// `set -e` with a failing emit and observe whether the shell stops.
const emitStatement = (() => {
  const lines = script.split("\n");
  const collected = [lines[emitCallLineIndex]];
  for (let i = emitCallLineIndex + 1; i < lines.length; i += 1) {
    const joined = collected[collected.length - 1].trimEnd();
    const next = lines[i].trim();
    if (!joined.endsWith("\\") && !next.startsWith("||") && !next.startsWith("&&")) break;
    collected.push(lines[i]);
  }
  return collected.map((line) => line.replace(/^ {4}/, "")).join("\n");
})();

test("a failed handoff aborts the run instead of exiting 0 with an unnamed lock", () => {
  const harness = [
    "set -euo pipefail",
    "LOCK_OWNER_OUT=/dev/null",
    `${OWNER_FN}() { return 1; }`,
    emitStatement,
    'echo "CONTINUED"',
  ].join("\n");
  const result = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
  assert.doesNotMatch(
    result.stdout,
    /CONTINUED/,
    `a failed ${OWNER_FN} must abort so cleanup_on_exit retires the lock; the call ran on past it:\n${emitStatement}`,
  );
  assert.notEqual(result.status, 0, "the run must fail visibly rather than report success");
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

// The probe's FAILURE branch is the realistic production case — a read-only
// mount — and the only one of the four with non-trivial logic, so it is worth
// exercising rather than trusting. Root defeats the mode bits and would write
// happily, so these skip rather than assert a falsehood when running as root.
const runsAsRoot = typeof process.geteuid === "function" && process.geteuid() === 0;

test("an unwritable parent directory is rejected before the approval ring is touched", { skip: runsAsRoot && "mode bits do not constrain root" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperclip-owner-ro-"));
  chmodSync(dir, 0o500);
  try {
    const result = runWithOwnerOut(path.join(dir, "lock-owner.txt"));
    assert.equal(result.status, 2, `got: ${result.stderr}`);
    assert.match(result.stderr, /PAPERCLIP_APPROVAL_LOCK_OWNER_OUT=/);
    assert.match(result.stderr, /is not writable/, `got: ${result.stderr}`);
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("an existing but unwritable target is rejected", { skip: runsAsRoot && "mode bits do not constrain root" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paperclip-owner-ro-target-"));
  const outPath = path.join(dir, "lock-owner.txt");
  writeFileSync(outPath, "");
  chmodSync(outPath, 0o400);
  const result = runWithOwnerOut(outPath);
  assert.equal(result.status, 2, `got: ${result.stderr}`);
  assert.match(result.stderr, /exists and is not writable/, `got: ${result.stderr}`);
});

test("an unset handoff path skips validation entirely", () => {
  const result = runWithKnobs({});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /PAPERCLIP_DEPLOY_KUBECONFIG must name the deploy credential/);
  assert.doesNotMatch(result.stderr, /PAPERCLIP_APPROVAL_LOCK_OWNER_OUT/);
});

// Review of #1646 read the span between the ring write and the workflow
// publishing `lock_owner` to `$GITHUB_OUTPUT` as a residual wedge: the
// admissibility probe alone budgets ~286s, and an operator cancelling in there
// was thought to leave a live lock the cleanup step cannot name.
//
// It does not, and the reason is entirely mechanical: INT and TERM are trapped
// into a non-zero `exit`, which runs the EXIT trap, which is `cleanup_on_exit`
// -- and the arm at the ring write is still set, because nothing disarms it
// until the handoff has succeeded. So the script retires its own lock before the
// step shell exits. `runCleanup` above already proves the armed+failure branch
// retires; what was untested is the two facts that make a CANCELLATION reach it.
//
// Both are asserted on real source offsets rather than on text presence, because
// the way this window reopens is a disarm migrating into that span, and that
// would leave every other test in this file green.
test("nothing disarms the cleanup between the ring write and the probe", () => {
  const armIndex = script.indexOf("lock_cleanup_armed=yes");
  assert.notEqual(armIndex, -1, "the arming site moved or was renamed");
  const emitIndex = script.indexOf("    emit_lock_owner", armIndex);
  assert.notEqual(emitIndex, -1, "the owner handoff no longer follows the arming site");

  // The span has to be measured from the END of the rotation loop, not from the
  // emit call. The loop's own tail DOES disarm -- deliberately, so that a later
  // exact-match retry cannot retire a lock another process took -- and that line
  // sits textually after the emit while being on a path that never emitted: the
  // successful write `break`s straight past it. Slicing from the emit would
  // therefore flag a correct disarm, which is the failure this test had on its
  // first run. From `done` onwards, everything executes unconditionally on the
  // path that minted a lock, so a disarm in THIS span is the real regression.
  const loopEnd = script.indexOf("\ndone\n", emitIndex);
  assert.notEqual(loopEnd, -1, "the rotation loop's end moved");
  const probeIndex = script.indexOf('for attempt in $(seq 1 "$PROBE_ATTEMPTS")', loopEnd);
  assert.notEqual(probeIndex, -1, "the admissibility probe moved");

  const disarms = script
    .slice(loopEnd, probeIndex)
    .split("\n")
    .filter((line) => line.trim() === 'lock_cleanup_armed=""');
  assert.deepEqual(
    disarms,
    [],
    "a disarm here would let a cancellation during the probe strand a live lock",
  );
});

// Exercises release_in_flight_lock's read failure directly, with kubectl stubbed
// rather than mocked away, so the branch runs as written. Without this the
// empty-stderr guard could be deleted and every other test here stays green --
// which is exactly how the dangling-colon regression it fixes got shipped.
function runRelease({ stderrText }) {
  const dir = mkdtempSync(path.join(tmpdir(), "paperclip-release-"));
  const errFile = path.join(dir, "release_err");
  const fn = script.slice(
    script.indexOf("release_in_flight_lock() {"),
    script.indexOf("\nemit_lock_owner() {"),
  );
  const harness = [
    "set -uo pipefail",
    "NAMESPACE=paperclip-release-approvals",
    "CONFIGMAP=paperclip-api-approved-images",
    "RETIRE_ATTEMPTS=1",
    `release_err=${JSON.stringify(errFile)}`,
    // Fails, writing exactly what the case under test needs it to write.
    `kubectl() { ${stderrText ? `printf '%s\\n' ${JSON.stringify(stderrText)} >&2; ` : ""}return 1; }`,
    fn,
    "release_in_flight_lock",
  ].join("\n");
  const r = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr };
}

test("the retirement loop and its trailing-sleep guard cannot drift apart", () => {
  // Sugg 1's actual point: the bound was spelled `1 2 3` while the guard it
  // paces reads a named constant, so changing one silently desynchronises them.
  // Asserted on the extracted function, and on the two bounds referring to the
  // SAME identifier -- a presence check for "RETIRE_ATTEMPTS" would pass on a
  // loop still hardcoded to `1 2 3` with the constant used only in the guard.
  const fn = script.slice(
    script.indexOf("release_in_flight_lock() {"),
    script.indexOf("\nemit_lock_owner() {"),
  );
  const loop = fn.match(/for attempt in \$\(seq 1 "\$(\w+)"\); do/);
  assert.ok(loop, "the retirement loop must take its bound from a named constant, not `1 2 3`");
  const guard = fn.match(/if \(\( attempt < (\w+) \)\); then/);
  assert.ok(guard, "the trailing sleep must be guarded by an explicit `if`, not `(( … )) && sleep`");
  assert.equal(
    guard[1],
    loop[1],
    `guard bound ${guard[1]} must be the loop bound ${loop[1]} -- two names is the drift this prevents`,
  );
  // And that name must resolve on the approval path. Declared inside retire-only
  // mode it would be unset here, and `set -u` would abort cleanup_on_exit
  // mid-retirement -- turning this parity fix into a fresh wedge.
  const decl = new RegExp(`^readonly ${loop[1]}=\\d+$`, "m");
  assert.match(script, decl, `${loop[1]} must be declared at top level, reachable from cleanup_on_exit`);
  const declIndex = script.search(decl);
  assert.ok(
    declIndex < script.indexOf("release_in_flight_lock() {"),
    "the declaration must precede the function that reads it",
  );
});

test("a read failure with no stderr still explains itself", () => {
  // kubectl killed by a signal, or dead before it wrote: the old code printed
  // "cannot read ...:" and then nothing at all after the colon.
  const result = runRelease({ stderrText: "" });
  assert.equal(result.status, 1, "an unreadable ConfigMap must fail closed");
  assert.match(
    result.stderr,
    /\(kubectl produced no error output\)/,
    "an empty stderr must say so rather than leaving a dangling colon",
  );
  assert.doesNotMatch(
    result.stderr,
    /to retire the in-flight lock:\s*$/,
    "the message must not end at the colon it promises to expand on",
  );
});

test("a read failure WITH stderr passes the cause through", () => {
  // The other direction: the guard must not swallow a real cause. Without this
  // row, replacing the sed with an unconditional placeholder would pass.
  const result = runRelease({ stderrText: 'Error from server (Forbidden): configmaps is forbidden' });
  assert.match(result.stderr, /Forbidden/, "the real kubectl cause must survive");
  assert.doesNotMatch(
    result.stderr,
    /\(kubectl produced no error output\)/,
    "the placeholder must not appear when kubectl did write a cause",
  );
});

test("a failed retirement names where the owner still exists, not a dead end", () => {
  // The Important finding this replaces: the operator is handed the wedge on
  // exactly this path, and every source the old text pointed at is empty of the
  // owner -- LOCK_OWNER_ID reaches stdout only in the success epilogue, past
  // this window entirely. Retire-only mode refuses to run without the owner, so
  // "re-run with ABANDON_IN_FLIGHT_OWNER" without saying where to get it is not
  // a recovery path. The annotation is the one place it provably still exists.
  const result = runCleanup({ armed: true, preserve: false, status: 1, releaseFails: true });
  assert.equal(result.released, false, "this test needs the retirement to have FAILED");
  assert.match(
    result.stderr,
    /kubectl -n paperclip-release-approvals get configmap paperclip-api-approved-images/,
    "the warning must name the cluster read that recovers the owner",
  );
  assert.match(
    result.stderr,
    /approval-in-flight-owner/,
    "the warning must name the owner annotation specifically, not just the ConfigMap",
  );
});

test("a signal is routed into the cleanup rather than killing the script outright", () => {
  // Without these three lines a SIGTERM kills bash with no trap, the lock stays
  // live, and the cleanup step in docker.yml cannot name it -- which is exactly
  // the residual the review described. They are the whole reason it is a
  // SIGKILL-only window and not a cancellation-shaped one.
  for (const wiring of ["trap cleanup_on_exit EXIT", "trap 'exit 130' INT", "trap 'exit 143' TERM"]) {
    assert.ok(script.includes(wiring), `missing trap wiring: ${wiring}`);
  }

  // Presence alone is the failure mode the sibling test above deliberately
  // avoids. A second EXIT trap installed after this one silently displaces
  // cleanup_on_exit and leaves every assertion here green -- and that is not
  // hypothetical: this same script installs `trap 'rm -f "$retire_err"' EXIT`
  // in retire-only mode. It is harmless only because that mode always exits
  // first, a property nothing asserted until now. So assert on real source
  // offsets: cleanup_on_exit must be the LAST EXIT trap in the file, and the
  // retire-only trap that precedes it must sit on a path that has already
  // exited.
  const exitTraps = [...script.matchAll(/^[ \t]*trap[ \t]+(.+?)[ \t]+EXIT[ \t]*$/gm)];
  assert.ok(exitTraps.length >= 1, "no EXIT trap found at all");
  const lastTrap = exitTraps[exitTraps.length - 1];
  assert.equal(
    lastTrap[1],
    "cleanup_on_exit",
    `the last EXIT trap must be cleanup_on_exit, found ${lastTrap[1]} -- ` +
      "a trap installed after it displaces the lock retirement entirely",
  );

  // And the statuses those traps synthesise do land in the retire branch: the
  // branch keys on "non-zero", so 143/130 must behave exactly like any failure.
  for (const status of [143, 130]) {
    const result = runCleanup({ armed: true, preserve: false, status });
    assert.equal(result.released, true, `exit ${status} must retire the lock it minted`);
    assert.equal(result.status, status, "the cleanup must not swallow the signal's status");
  }
});
