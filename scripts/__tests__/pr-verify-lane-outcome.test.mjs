import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf8");

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

function runVerifyStep(results) {
  const script = getVerifyLaneScript();
  const env = {
    ...process.env,
    TYPECHECK_RELEASE_REGISTRY_RESULT: results.typecheck_release_registry ?? "success",
    GENERAL_TESTS_RESULT: results.general_tests ?? "success",
    WORKTREE_INSTALL_RESULT: results.worktree_install ?? "success",
    BUILD_RESULT: results.build ?? "success",
    HELM_CHART_RESULT: results.helm_chart ?? "success",
  };
  return spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
}

test("verify step passes when every lane succeeds", () => {
  const result = runVerifyStep({});
  assert.equal(result.status, 0);
});

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

// BLO-20733 / Ally review of PR #973: the `Helm chart` lane exists and runs, but
// running is not gating. `verify` is the required context, so a lane it neither
// `needs` nor asserts can go red beside a green required check. Both halves are
// load-bearing and fail independently:
//   - absent from `needs`  => `needs.helm_chart.result` renders EMPTY, and the
//     lane silently never gates (the failure mode being closed here).
//   - absent from the script => the result is collected and ignored.
test("verify declares helm_chart as a dependency, so its result is actually populated", () => {
  const needsMatch = workflow.match(/\n {2}verify:\n(?: {4}.*\n| *\n)*? {4}needs: \[([^\]]*)\]/);
  assert.notEqual(needsMatch, null, "verify job must declare a needs list");

  const needs = needsMatch[1].split(",").map((lane) => lane.trim());
  assert.ok(
    needs.includes("helm_chart"),
    `verify.needs must include helm_chart or its result is always empty; got: ${needs.join(", ")}`,
  );
});

test("verify step exits non-zero when the Helm chart lane fails", () => {
  const result = runVerifyStep({ helm_chart: "failure" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane failure::/);
  assert.match(result.stdout, /helm_chart/);
});

test("verify step reports a cancelled Helm chart lane as cancelled, not as a diff defect", () => {
  const result = runVerifyStep({ helm_chart: "cancelled" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /::error title=verify: lane cancelled::/);
  assert.match(result.stdout, /helm_chart/);
  assert.doesNotMatch(result.stdout, /::error title=verify: lane failure::/);
});
