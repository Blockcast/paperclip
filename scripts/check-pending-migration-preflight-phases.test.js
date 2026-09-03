// Behavioural tests for the pre-flight's two-phase wait (BLO-31254).
//
// These drive check-pending-migrations.sh for real against a stub kubectl, so
// the phase ordering, budget accounting and message selection are exercised
// rather than grepped. The defect being guarded was purely one of control
// flow -- a single budget charged image transfer against the migration
// allowance -- and a static assertion cannot tell that apart from a fix.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = new URL("../.github/scripts/check-pending-migrations.sh", import.meta.url).pathname;
const DIGEST = `sha256:${"ab".repeat(32)}`;

// Deliberately tiny so a budget being charged the wrong phase is loud. Shared
// with the run-budget floor below so the two cannot drift apart -- lowering
// this alone would otherwise fail that test spuriously, and raising it alone
// would weaken the assertion while keeping it green.
const RUN_BUDGET_SECONDS = 2;

// Large enough that "rode out the budget" and "bailed early" are separable on a
// real clock. Feeds the env, the early-bail ceiling and the messages below, so
// that lowering it to save wall-clock -- which this file's budgets have already
// been subjected to once, see the note at the poll override -- shrinks the
// ceiling with it instead of leaving a fixed ceiling the budget can no longer
// reach. A ceiling above its own budget is unfalsifiable and stays green.
const STARTUP_BUDGET_SECONDS = 60;

// The bar for "did not ride out the startup budget". Derived, not chosen, so it
// tracks the budget it is a fraction of.
const EARLY_BAIL_CEILING_SECONDS = STARTUP_BUDGET_SECONDS / 6;

// A third startup budget, kept short because the recoverable-pull-error test
// rides it out in full. Declared here with the others so it cannot drift from
// the floor derived below.
const PULL_ERROR_BUDGET_SECONDS = 5;

// The bar for "kept polling through a recoverable pull error". Derived so the
// two move together: lowering the budget alone would otherwise put the floor
// above it and fail a correct script, and raising it alone would silently
// weaken the assertion. The margin absorbs the script's whole-second deadline
// compare, which can round down ~1s early against this wall clock.
const PULL_ERROR_FLOOR_SECONDS = PULL_ERROR_BUDGET_SECONDS * 0.7;

// Stands in for the cluster. Container start is a function of elapsed time so a
// slow image pull can be simulated without one.
const STUB = `#!/usr/bin/env bash
args="$*"
now=$(date +%s)
if [ -f "$STUB_STATE/start" ]; then start=$(cat "$STUB_STATE/start"); else start=$now; echo "$now" > "$STUB_STATE/start"; fi
elapsed=$(( now - start ))
echo "$args" >> "$STUB_STATE/calls"
case "$args" in
  *"apply -f"*)            cat >/dev/null; exit 0 ;;
  *"delete job"*)          exit 0 ;;
  *"get pods -l job-name"*) [ "\${STUB_NO_POD:-0}" = 1 ] || echo "preflight-pod-0"; exit 0 ;;
  *"startedAt"*)
    # The kubelet stamps a start time only once the container actually runs.
    # STUB_NEVER_STARTS models eviction/preemption: the pod reaches a terminal
    # phase straight from Pending and no stamp is ever written.
    if [ "\${STUB_NEVER_STARTS:-0}" != 1 ] && [ "$elapsed" -ge "\${STUB_READY_AFTER:-0}" ]; then
      echo "2026-09-02T00:00:00Z"
    fi
    exit 0 ;;
  *"{.status.phase}"*)
    if [ "$elapsed" -ge "\${STUB_READY_AFTER:-0}" ]; then echo "\${STUB_TERMINAL_PHASE:-Running}"; else echo "Pending"; fi
    exit 0 ;;
  *"waiting.reason"*)      echo "\${STUB_WAITING_REASON:-ContainerCreating}"; exit 0 ;;
  *"get events"*)          echo "Normal Pulled Successfully pulled image in 3m3.14s. Image size: 1695082158 bytes"; exit 0 ;;
  *" logs "*)              echo "stub pre-flight output"; exit 0 ;;
  *"condition=complete"*)
    # Model kubectl wait honestly: block up to --timeout, and only report
    # complete once the container has actually started. This is what makes the
    # slow-pull test a real regression test -- a single budget shorter than the
    # pull cannot satisfy it, exactly as run 33601878894 did not.
    budget=$(printf '%s\\n' "$args" | grep -oE 'timeout=[0-9]+' | head -1 | cut -d= -f2)
    deadline=$(( now + \${budget:-0} ))
    # STUB_JOB_RESULT=timeout models a job that starts and then never settles.
    # It must ride out the whole --timeout rather than resolving early, or the
    # run-budget test never spends the budget it is named for. "failed" instead
    # resolves as soon as the container starts, which real kubectl does NOT do:
    # --for=condition=complete never sees Complete go true on a failed Job and
    # has no second condition to give up on, so it blocks the full --timeout
    # (kubernetes/kubectl#1629; the underlying gap is kubernetes/kubernetes#100248,
    # "wait on multiple conditions", closed rotten rather than fixed). The
    # divergence is deliberate and buys ~2s per test; the script's verdict is
    # identical either way. Its operational corollary is real though -- a
    # genuine FAILED verdict in production spends the whole run budget before
    # it prints, which the job timeout fold covers.
    while :; do
      if [ "\${STUB_JOB_RESULT:-complete}" != timeout ] && [ $(( $(date +%s) - start )) -ge "\${STUB_READY_AFTER:-0}" ]; then
        [ "\${STUB_JOB_RESULT:-complete}" = complete ] && exit 0 || exit 1
      fi
      [ "$(date +%s)" -lt "$deadline" ] || exit 1
      sleep 1
    done ;;
  *"condition=failed"*)    [ "\${STUB_JOB_RESULT:-complete}" = failed ] && exit 0 || exit 1 ;;
esac
exit 0
`;

function runPreflight(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "preflight-stub-"));
  const kubectl = join(dir, "kubectl");
  writeFileSync(kubectl, STUB);
  chmodSync(kubectl, 0o755);

  const options = {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      STUB_STATE: dir,
      DIGEST,
      NS: "paperclip-test",
      PREFLIGHT_TIMEOUT_SECONDS: String(RUN_BUDGET_SECONDS),
      PREFLIGHT_STARTUP_TIMEOUT_SECONDS: String(STARTUP_BUDGET_SECONDS),
      // These tests wait on real clocks, so the production 5s poll would make
      // the file cost ~32s against the policy job's one-minute step bound. The
      // waits stay real; only their granularity shrinks.
      PREFLIGHT_POLL_SECONDS: "1",
      ...env,
    },
  };

  try {
    return { code: 0, output: execFileSync("bash", [SCRIPT], { ...options, stdio: "pipe" }) };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test("a pull slower than the run budget still passes", () => {
  // The BLO-31254 regression: the container becomes Running only after the
  // 2s run budget would already have expired. A single budget fails here; a
  // startup phase that gates the run clock does not.
  const { code, output } = runPreflight({ STUB_READY_AFTER: "3" });

  assert.equal(code, 0, `slow pull must not fail the gate:\n${output}`);
  assert.match(output, /PASSED/);
  const started = Number(output.match(/container started within (\d+)s/)?.[1]);
  assert.ok(
    started > 2,
    `startup must have outlasted the 2s run budget, proving the pull was not charged to it (got ${started}s)`,
  );
});

test("a container that never starts is reported as infrastructure, not a migration verdict", () => {
  const { code, output } = runPreflight({
    STUB_READY_AFTER: "9999",
    PREFLIGHT_STARTUP_TIMEOUT_SECONDS: "4",
  });

  assert.equal(code, 1, "an unstarted check must still fail closed");
  assert.match(output, /INCONCLUSIVE/);
  assert.match(output, /never started/, "the message must name the startup phase as the cause");
  assert.match(output, /migration check itself never ran/, "it must disclaim any migration verdict");
  assert.match(output, /ContainerCreating/, "the observed waiting reason belongs in the message");
  // The pull duration is the evidence an operator would otherwise have to go
  // describe the pod to find.
  assert.match(output, /Successfully pulled image in 3m3\.14s/, "pod events must be surfaced inline");
});

test("a started-but-unfinished check is reported as migrations in trouble", () => {
  const began = Date.now();
  const { code, output } = runPreflight({ STUB_JOB_RESULT: "timeout" });
  const elapsed = (Date.now() - began) / 1000;

  assert.equal(code, 1);
  assert.match(output, /INCONCLUSIVE/);
  assert.match(output, /run budget/, "the message must attribute the stall to the run phase");
  assert.match(output, /image pull is NOT implicated/, "it must rule the pull out explicitly");
  assert.doesNotMatch(output, /never started/, "this is the opposite cause and must not reuse that wording");
  // Without this the test passes on a stub that resolves instantly, i.e. it
  // would assert the message of a run-budget exhaustion that never happened.
  // Derived from the budget rather than restated, with slop for the
  // whole-second compare inside the stub.
  const floor = RUN_BUDGET_SECONDS * 0.75;
  assert.ok(
    elapsed >= floor,
    `the run budget must actually be spent, not short-circuited (took ${elapsed.toFixed(1)}s)`,
  );
});

test("the two INCONCLUSIVE causes are distinguishable from the log alone", () => {
  const startup = runPreflight({ STUB_READY_AFTER: "9999", PREFLIGHT_STARTUP_TIMEOUT_SECONDS: "4" }).output;
  const run = runPreflight({ STUB_JOB_RESULT: "timeout" }).output;

  const line = (out) => out.split("\n").find((l) => l.includes("INCONCLUSIVE"));
  assert.notEqual(line(startup), line(run), "both causes must not render the same INCONCLUSIVE line");
});

test("a failing check still reports the migration verdict", () => {
  const { code, output } = runPreflight({ STUB_JOB_RESULT: "failed" });

  assert.equal(code, 1);
  assert.match(output, /FAILED — a pending migration needs its index precreated/);
  assert.match(output, /stub pre-flight output/, "the remediation logs must be surfaced");
});

test("a check that completes between polls is not mistaken for never having started", () => {
  // backoffLimit is 0, so a fast job can be Succeeded by the first observation.
  // Treating a terminal phase as "never started" would discard a real answer.
  const { code, output } = runPreflight({ STUB_TERMINAL_PHASE: "Succeeded" });

  assert.equal(code, 0, `a already-succeeded pod must be read as started:\n${output}`);
  assert.match(output, /PASSED/);
});

test("a pod that dies before its container runs is not reported as a migration verdict", () => {
  // A pod can reach Failed straight from Pending -- evicted under node pressure,
  // or preempted -- having never started a container. Reading pod phase alone
  // would call that "started", hand phase 2 a job whose `condition=failed` is
  // already true, and print "a pending migration needs its index precreated":
  // a migration verdict from a check that never inspected a migration. The
  // stub returns exactly that verdict if the script asks for it.
  const began = Date.now();
  const { code, output } = runPreflight({
    STUB_NEVER_STARTS: "1",
    STUB_TERMINAL_PHASE: "Failed",
    STUB_JOB_RESULT: "failed",
    PREFLIGHT_STARTUP_TIMEOUT_SECONDS: String(STARTUP_BUDGET_SECONDS),
  });
  const elapsed = (Date.now() - began) / 1000;

  assert.equal(code, 1, "an unstarted check must still fail closed");
  assert.match(output, /INCONCLUSIVE/);
  assert.doesNotMatch(
    output,
    /needs its index precreated/,
    "a container that never ran cannot have produced a migration verdict",
  );
  assert.match(
    output,
    /without ever starting its container/,
    "the message must name the real cause",
  );
  assert.match(output, /migration check itself never ran/, "it must disclaim any migration verdict");
  // backoffLimit is 0, so nothing will replace the pod; the rest of the budget
  // cannot change the answer.
  assert.ok(
    elapsed < EARLY_BAIL_CEILING_SECONDS,
    `a terminal phase with no start stamp must not ride out the budget (took ${elapsed}s)`,
  );
});

test("a config error fails fast instead of riding out the startup budget", () => {
  // A missing secret key never self-heals, so waiting the full budget only
  // delays a decided verdict.
  const began = Date.now();
  const { code, output } = runPreflight({
    STUB_READY_AFTER: "9999",
    STUB_WAITING_REASON: "CreateContainerConfigError",
    PREFLIGHT_STARTUP_TIMEOUT_SECONDS: String(STARTUP_BUDGET_SECONDS),
  });
  const elapsed = (Date.now() - began) / 1000;

  assert.equal(code, 1);
  assert.match(output, /CreateContainerConfigError/);
  assert.ok(
    elapsed < EARLY_BAIL_CEILING_SECONDS,
    `must not burn the whole ${STARTUP_BUDGET_SECONDS}s startup budget on a terminal error (took ${elapsed}s)`,
  );
  // Bailing early and exhausting the budget are different facts. Claiming the
  // container "never started within its Ns startup budget" after 0s would
  // point an operator at the budget when the budget was never the constraint.
  assert.match(output, /terminal container error/, "the message must name the early bail as such");
  assert.doesNotMatch(
    output,
    /within its \d+s startup budget/,
    "a terminal error must not be reported as budget exhaustion",
  );
});

test("a transient pull error rides out the startup budget rather than failing fast", () => {
  // ErrImagePull/ImagePullBackOff routinely recover. Failing fast on them
  // would recreate exactly the defect the startup phase exists to fix.
  const began = Date.now();
  const { output } = runPreflight({
    STUB_READY_AFTER: "9999",
    STUB_WAITING_REASON: "ImagePullBackOff",
    PREFLIGHT_STARTUP_TIMEOUT_SECONDS: String(PULL_ERROR_BUDGET_SECONDS),
  });
  const elapsed = (Date.now() - began) / 1000;

  // The claim under test is "kept polling" rather than "bailed on sight" -- the
  // terminal-error path returns in ~0.2s, so any floor in seconds settles it
  // without making the assertion a hostage to second-granularity slop.
  assert.ok(
    elapsed >= PULL_ERROR_FLOOR_SECONDS,
    `must keep waiting through a recoverable pull error (took ${elapsed}s)`,
  );
  assert.match(output, /ImagePullBackOff/);
});
