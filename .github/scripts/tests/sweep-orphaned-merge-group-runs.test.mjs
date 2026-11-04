import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../sweep-orphaned-merge-group-runs.sh", import.meta.url));

function classifyRefProbe(rc, stderr) {
  const result = spawnSync(
    "bash",
    ["-c", 'source "$1"; classify_ref_probe "$2" "$3"', "classifier-test", script, String(rc), stderr],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("only an explicit 404 classifies a ref as gone", () => {
  const cases = [
    ["alive", 0, ""],
    ["gone", 1, "gh: Not Found (HTTP 404)"],
    ["unknown", 1, "gh: Forbidden (HTTP 403)"],
    ["unknown", 1, "gh: API rate limit exceeded (HTTP 429)"],
    ["unknown", 1, "dial tcp: i/o timeout"],
    ["unknown", 1, ""],
    ["unknown", 1, "gh: Server Error (HTTP 500)"],
  ];

  for (const [expected, rc, stderr] of cases) {
    assert.equal(classifyRefProbe(rc, stderr), expected, `${rc}: ${stderr}`);
  }
});

function decidedFailedJobs(stdin) {
  const result = spawnSync(
    "bash",
    ["-c", 'source "$1"; decided_failed_jobs', "decided-test", script],
    { encoding: "utf8", input: stdin },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("BLO-51600: only failure/timed_out jobs decide a run; in-flight and green never do", () => {
  assert.equal(decidedFailedJobs("success\tBuild\n\tGeneral tests (server 3/6)\nskipped\tCanary Dry Run\n"), "");
  assert.equal(decidedFailedJobs("cancelled\tBuild\nneutral\tx\n"), "");
  assert.equal(decidedFailedJobs(""), "");
  assert.equal(
    decidedFailedJobs("failure\tGeneral tests (server 3/6)\n\tBuild\ntimed_out\tBuild\nsuccess\tpolicy\n"),
    "General tests (server 3/6)\nBuild",
  );
});

test("BLO-51600: a failed job outside verify.needs never decides a run (run 41685616129 merged with e2e red)", () => {
  assert.equal(decidedFailedJobs("failure\te2e\nfailure\tCanary Dry Run\nsuccess\tverify\n"), "");
  assert.equal(decidedFailedJobs("failure\tGeneral tests\n"), "General tests");
  assert.equal(decidedFailedJobs("failure\tGeneral testsX\n"), "");
  assert.equal(decidedFailedJobs("failure\tpolicy\nfailure\tally-verdict\n"), "policy\nally-verdict");
});

test("BLO-51600: GATING_JOBS matches pr.yml verify's lanes plus policy and ally-verdict", () => {
  const prYml = readFileSync(new URL("../../workflows/pr.yml", import.meta.url), "utf8");
  const laneNames = [...prYml.match(/lane_job_names=\(\n([\s\S]*?)\n\s*\)/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const needs = prYml.match(/\n  verify:\n[\s\S]*?needs:\s*\[([^\]]*)\]/)[1].split(",").map((n) => n.trim()).filter(Boolean);
  // verify.needs = one lane per lane_job_names entry + ally_verdict; a new
  // need means a new lane, so GATING_JOBS must be revisited.
  assert.equal(needs.length, laneNames.length + 1, `verify.needs changed: ${needs}`);
  assert.ok(needs.includes("ally_verdict"));
  const result = spawnSync("bash", ["-c", 'source "$1"; printf "%s\\n" "${GATING_JOBS[@]}"', "list", script], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [...laneNames, "policy", "ally-verdict"]);
});
