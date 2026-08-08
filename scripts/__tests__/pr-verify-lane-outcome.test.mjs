import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf8");

test("PR verification runs for merge-queue heads with event-appropriate diff SHAs", () => {
  assert.match(workflow, /\n  merge_group:\n    types:\n      - checks_requested\n/);
  assert.match(
    workflow,
    /PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.merge_group\.base_sha \}\}/,
  );
  assert.match(
    workflow,
    /PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.event\.merge_group\.head_sha \}\}/,
  );
  assert.match(
    workflow,
    /if: >-\n          github\.event_name == 'pull_request' &&\n          github\.head_ref != 'chore\/refresh-lockfile'/,
    "merge-group runs must not re-evaluate PR-only lockfile exemptions without author/branch metadata",
  );
  assert.match(workflow, /\n  verify:\n/);
});

// BLO-20867: extract the actual `run:` shell script from the `verify` job's
// "Fail if any split verify lane failed" step so this test exercises the real
// script, not a re-implementation of it.
function getVerifyLaneScript() {
  const stepMarker = "\n      - name: Fail if any split verify lane failed\n";
  const stepStart = workflow.indexOf(stepMarker);
  assert.notEqual(stepStart, -1, "pr.yml must define the verify lane-outcome step");

  const runMarker = "\n        run: |\n";
  const runStart = workflow.indexOf(runMarker, stepStart);
  assert.notEqual(runStart, -1, "verify lane-outcome step must use a `run: |` block");

  const remainder = workflow.slice(runStart + runMarker.length);
  const lines = remainder.split("\n");
  const scriptLines = [];
  for (const line of lines) {
    if (line !== "" && !line.startsWith("          ")) break;
    scriptLines.push(line.slice(10));
  }
  return scriptLines.join("\n");
}

function laneEnv(results) {
  return {
    HELM_CHART_RESULT: results.helm_chart ?? "success",
    TYPECHECK_RELEASE_REGISTRY_RESULT: results.typecheck_release_registry ?? "success",
    GENERAL_TESTS_RESULT: results.general_tests ?? "success",
    WORKTREE_INSTALL_RESULT: results.worktree_install ?? "success",
    OPENCODE_RESPONSES_REPLAY_RESULT: results.opencode_responses_replay ?? "success",
    BUILD_RESULT: results.build ?? "success",
    VERIFY_SERIALIZED_SERVER_RESULT: results.verify_serialized_server ?? "success",
    VENDOR_CLAUDE_K8S_RESULT: results.vendor_claude_k8s ?? "success",
  };
}

function runVerifyStep(results) {
  const script = getVerifyLaneScript();
  const env = { ...process.env, ...laneEnv(results) };
  return spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
}

// BLO-17980: adding a lane to the `verify` job's lane list without also giving
// it a default here leaves its env var unset. The script's `case` treats an
// empty result as `*)` — a failure — so EVERY scenario in this file, including
// "every lane succeeds", starts emitting a spurious lane-failure annotation.
// That is exactly how the `vendor_claude_k8s` lane broke this suite.
//
// The workflow moved from an associative `declare -A lane_results` to two
// PARALLEL indexed arrays (`lane_names` + `lane_results`) for portability, so
// this now also asserts the two stay the same length and in the same order.
// That pairing is load-bearing and silent when wrong: the script indexes
// `lane_results[$i]` by `lane_names` position, so a single insertion into one
// array shifts every later lane onto the wrong result and misreports which lane
// failed — with no syntax error to catch it.
test("every lane in the workflow's lane list is paired and has a test default", () => {
  const script = getVerifyLaneScript();
  const readArray = (name) => {
    const start = script.indexOf(`${name}=(`);
    assert.notEqual(start, -1, `could not find ${name} in pr.yml`);
    return script
      .slice(start + `${name}=(`.length, script.indexOf(")", start))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  };

  const laneNames = readArray("lane_names");
  const laneResults = readArray("lane_results");
  assert.ok(laneNames.length > 0, "could not parse lane_names out of pr.yml");
  assert.equal(
    laneNames.length,
    laneResults.length,
    `lane_names (${laneNames.length}) and lane_results (${laneResults.length}) must stay the ` +
      `same length — the script pairs them by index, so a mismatch silently reports the wrong lane`,
  );

  const defaults = laneEnv({});
  for (const [i, lane] of laneNames.entries()) {
    const envVar = laneResults[i].replace(/^"\$/, "").replace(/"$/, "");
    assert.equal(
      envVar,
      `${lane.toUpperCase()}_RESULT`,
      `lane_names[${i}] is '${lane}' but lane_results[${i}] reads $${envVar} — the arrays are ` +
        `out of order, so this lane's outcome would be read from a different lane's result`,
    );
    assert.ok(
      envVar in defaults,
      `lane '${lane}' reads $${envVar} in pr.yml but laneEnv() sets no default for it — ` +
        `add '${lane}' to laneEnv() or these tests will report it as a failed lane`,
    );
  }
});

test("verify step passes when every lane succeeds", () => {
  const result = runVerifyStep({});
  assert.equal(result.status, 0);
});

for (const [laneResult, annotation] of [
  ["failure", "failure"],
  ["skipped", "skipped"],
  ["cancelled", "cancelled"],
]) {
  test(`verify step rejects an OpenCode Responses replay ${laneResult}`, () => {
    const result = runVerifyStep({ opencode_responses_replay: laneResult });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout,
      new RegExp(`::error title=verify: lane ${annotation}::`),
    );
    assert.match(result.stdout, /opencode_responses_replay/);
  });
}

test("verify step exits non-zero and annotates a cancelled lane without asserting a specific cause", () => {
  const result = runVerifyStep({ general_tests: "cancelled" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane cancelled::/);
  assert.match(result.stdout, /general_tests/);
  // The annotation must not claim the cancellation IS infrastructure — only
  // that it's a possible cause. A manual cancel or another source is also
  // possible, and this job cannot tell them apart from here (gstack review,
  // BLO-20867 PR #964).
  assert.doesNotMatch(result.stdout, /This is a CI infrastructure interruption/);
  assert.doesNotMatch(result.stdout, /::error title=verify: lane failure::/);
  assert.doesNotMatch(result.stdout, /::error title=verify: lane skipped::/);
});

test("verify step exits non-zero and annotates a real lane failure distinctly from a cancellation", () => {
  const result = runVerifyStep({ build: "failure" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane failure::/);
  assert.match(result.stdout, /build/);
  assert.doesNotMatch(result.stdout, /::error title=verify: lane cancelled::/);
});

test("verify step treats Helm chart failure as a required lane failure", () => {
  const result = runVerifyStep({ helm_chart: "failure" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane failure::/);
  assert.match(result.stdout, /helm_chart/);
});

test("verify step annotates both a real failure and a cancellation when a run has both", () => {
  const result = runVerifyStep({ build: "failure", general_tests: "cancelled" });
  assert.notEqual(result.status, 0);
  // BLO-20867 AC-3 / PR #964 review: a cancelled lane must never be hidden
  // behind a failed one — both are real, distinct outcomes and each gets its
  // own annotation so the cancellation isn't misattributed to the diff.
  assert.match(result.stdout, /::error title=verify: lane failure::/);
  assert.match(result.stdout, /build/);
  assert.match(result.stdout, /::error title=verify: lane cancelled::/);
  assert.match(result.stdout, /general_tests/);
});

// BLO-20869: verify_serialized_server must be treated exactly like the other
// required lanes -- cancelled, skipped, or never-scheduled (which also reads
// as "skipped" via `needs`) must all fail this required check instead of
// being invisible to the merge gate.
test("verify step fails when the serialized server suite is cancelled", () => {
  const result = runVerifyStep({ verify_serialized_server: "cancelled" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane cancelled::/);
  assert.match(result.stdout, /verify_serialized_server/);
});

test("verify step fails when the serialized server suite is skipped", () => {
  const result = runVerifyStep({ verify_serialized_server: "skipped" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane skipped::/);
  assert.match(result.stdout, /verify_serialized_server/);
});

test("verify step fails when the serialized server suite genuinely fails", () => {
  const result = runVerifyStep({ verify_serialized_server: "failure" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane failure::/);
  assert.match(result.stdout, /verify_serialized_server/);
});

test("verify step annotates a skipped lane as an unmet dependency, not a failure", () => {
  const result = runVerifyStep({ worktree_install: "skipped" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane skipped::/);
  assert.match(result.stdout, /worktree_install/);
  assert.match(result.stdout, /policy/);
  assert.doesNotMatch(result.stdout, /::error title=verify: lane failure::/);
});

test("verify step annotates both a skipped and a cancelled lane when a run has both", () => {
  const result = runVerifyStep({ worktree_install: "skipped", general_tests: "cancelled" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane skipped::/);
  assert.match(result.stdout, /::error title=verify: lane cancelled::/);
});

test("verify step annotates both a real failure and a skipped lane when a run has both", () => {
  const result = runVerifyStep({ build: "failure", worktree_install: "skipped" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane failure::/);
  assert.match(result.stdout, /::error title=verify: lane skipped::/);
});

test("verify step exits non-zero for an unrecognized result and treats it as a failure", () => {
  const result = runVerifyStep({ general_tests: "timed_out" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane failure::/);
  assert.match(result.stdout, /general_tests/);
});
