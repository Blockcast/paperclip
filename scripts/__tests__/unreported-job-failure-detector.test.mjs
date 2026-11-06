import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyJob,
  commentMarkerFor,
  detect,
  groupByHeadSha,
  parseArgs,
  renderComment,
  runMayContainWindowFailure,
} from "../unreported-job-failure-detector.mjs";

// Fixtures transcribed from the live API on 2026-11-06 while triaging PEN-5738.
// `VICTIM_3_6` is check run 127689460237 on Blockcast/paperclip PR #3444 — one
// of the three jobs GitHub concluded `failure` after its runner lost DNS at
// `CompleteJobAsync`. Steps 1-8 closed `success`; the six that would have run or
// reported the tests were never closed at all.
const VICTIM_STEPS = [
  { name: "Set up job", status: "completed", conclusion: "success" },
  { name: "Checkout repository", status: "completed", conclusion: "success" },
  { name: "Setup pnpm", status: "completed", conclusion: "success" },
  { name: "Setup Node.js", status: "completed", conclusion: "success" },
  { name: "Restore pnpm store", status: "completed", conclusion: "success" },
  { name: "Install dependencies", status: "completed", conclusion: "success" },
  { name: "Restore build cache", status: "completed", conclusion: "success" },
  { name: "Build workspace", status: "completed", conclusion: "success" },
  { name: "Run grouped general test suites", status: "in_progress", conclusion: null },
  { name: "Run serialized server test shard", status: "pending", conclusion: null },
  { name: "Upload vitest JSON reports (flake ledger)", status: "pending", conclusion: null },
  { name: "Post Setup Node.js", status: "pending", conclusion: null },
  { name: "Post Setup pnpm", status: "pending", conclusion: null },
  { name: "Post Checkout repository", status: "pending", conclusion: null },
];

const VICTIM_3_6 = {
  id: 127689460237,
  name: "General tests (server 3/6)",
  conclusion: "failure",
  completed_at: "2026-11-06T06:22:14Z",
  html_url: "https://github.com/Blockcast/paperclip/actions/runs/42147146391/job/127689460237",
  steps: VICTIM_STEPS,
};

// A genuine shard failure: the failing step carries `conclusion: failure` and
// everything after it is `skipped`. Nothing is left null. This is the shape of
// all 94 genuine failures in the 2026-11-06 sample.
const GENUINE_FAILURE = {
  id: 1,
  name: "General tests (server 1/6)",
  conclusion: "failure",
  completed_at: "2026-11-06T06:20:00Z",
  steps: [
    { name: "Set up job", status: "completed", conclusion: "success" },
    { name: "Checkout repository", status: "completed", conclusion: "success" },
    { name: "Run grouped general test suites", status: "completed", conclusion: "failure" },
    { name: "Upload vitest JSON reports (flake ledger)", status: "completed", conclusion: "skipped" },
    { name: "Post Checkout repository", status: "completed", conclusion: "success" },
  ],
};

const RUN_3444 = {
  id: 42147146391,
  name: "PR",
  // The run was still in_progress with 7 jobs queued while these two jobs had
  // already been concluded `failure`. This is the live case.
  status: "in_progress",
  run_attempt: 1,
  head_sha: "f0ca5edf0ca5edf0ca5edf0ca5edf0ca5edf0ca5",
  head_branch: "cto/pen-5708-recovery-action-read-surface",
  updated_at: "2026-11-06T06:22:20Z",
  pull_requests: [{ number: 3444 }],
};

const WINDOW = {
  windowStartMs: Date.parse("2026-11-06T06:00:00Z"),
  windowEndMs: Date.parse("2026-11-06T07:00:00Z"),
  repo: "Blockcast/paperclip",
};

test("the real PEN-5738 victim is classified as an unreported runner", () => {
  const c = classifyJob(VICTIM_3_6);
  assert.equal(c.verdict, "runner_never_reported");
  assert.equal(c.stepCount, 14);
  assert.equal(c.unreportedSteps.length, 6);
  assert.deepEqual(c.unreportedSteps[0], { name: "Run grouped general test suites", status: "in_progress" });
});

test("a genuine shard failure is never called an infrastructure fault", () => {
  assert.equal(classifyJob(GENUINE_FAILURE).verdict, "genuine_failure");
  assert.equal(classifyJob(GENUINE_FAILURE).unreportedSteps.length, 0);
});

// The whole safety argument. Telling an author "ignore this red" about a real
// failure is the one outcome worse than staying quiet, so absence of step data
// must never be read as evidence of a silent runner.
test("missing or empty step data is indeterminate, never a false-red claim", () => {
  assert.equal(classifyJob({ conclusion: "failure" }).verdict, "indeterminate");
  assert.equal(classifyJob({ conclusion: "failure", steps: null }).verdict, "indeterminate");
  assert.equal(classifyJob({ conclusion: "failure", steps: [] }).verdict, "indeterminate");
  for (const job of [{ conclusion: "failure" }, { conclusion: "failure", steps: [] }]) {
    assert.notEqual(classifyJob(job).verdict, "runner_never_reported");
  }
});

test("only `failure` is in scope — cancelled and timed_out legitimately leave steps null", () => {
  for (const conclusion of ["cancelled", "timed_out", "success", "skipped", "action_required", null]) {
    const c = classifyJob({ ...VICTIM_3_6, conclusion });
    assert.equal(c.verdict, "not_a_failure", `${conclusion} must be out of scope`);
  }
});

test("a run still in_progress is inspected — the PEN-5738 run had queued jobs beside failed ones", () => {
  // Old `updated_at`, but not completed: must still be inspected, because its
  // jobs can be failing right now. Filtering to completed runs would have missed
  // the live incident entirely.
  assert.equal(runMayContainWindowFailure({ status: "in_progress", updated_at: "2026-11-06T03:18:56Z" }, WINDOW.windowStartMs), true);
  // Completed and stale: its jobs cannot have newly failed inside the window.
  assert.equal(runMayContainWindowFailure({ status: "completed", updated_at: "2026-11-06T03:18:56Z" }, WINDOW.windowStartMs), false);
  // Completed inside the window: inspect.
  assert.equal(runMayContainWindowFailure({ status: "completed", updated_at: "2026-11-06T06:30:00Z" }, WINDOW.windowStartMs), true);
  assert.equal(runMayContainWindowFailure(null, WINDOW.windowStartMs), false);
});

test("detect reports the victim and counts the genuine failure separately", () => {
  const v = detect({ ...WINDOW, runs: [{ run: RUN_3444, jobs: [VICTIM_3_6, GENUINE_FAILURE] }] });
  assert.equal(v.firing, true);
  assert.equal(v.failedJobsScanned, 2);
  assert.equal(v.genuineFailureCount, 1);
  assert.equal(v.findings.length, 1);
  assert.equal(v.findings[0].jobId, 127689460237);
  assert.equal(v.findings[0].headSha, RUN_3444.head_sha);
  assert.deepEqual(v.findings[0].pullRequests, [3444]);
});

test("failures outside the window are not reported", () => {
  const stale = { ...VICTIM_3_6, completed_at: "2026-11-06T05:00:00Z" };
  const v = detect({ ...WINDOW, runs: [{ run: RUN_3444, jobs: [stale] }] });
  assert.equal(v.firing, false);
  assert.equal(v.failedJobsScanned, 0);
});

test("a job with an unparseable completed_at is skipped rather than assumed in-window", () => {
  const v = detect({ ...WINDOW, runs: [{ run: RUN_3444, jobs: [{ ...VICTIM_3_6, completed_at: null }] }] });
  assert.equal(v.firing, false);
  assert.equal(v.failedJobsScanned, 0);
});

test("a clean scan still reports how much it looked at, so quiet cannot be confused with vacuous", () => {
  const v = detect({ ...WINDOW, runs: [{ run: RUN_3444, jobs: [GENUINE_FAILURE] }] });
  assert.equal(v.firing, false);
  assert.equal(v.failedJobsScanned, 1);
  assert.equal(v.genuineFailureCount, 1);
  const empty = detect({ ...WINDOW, runs: [] });
  assert.equal(empty.firing, false);
  assert.equal(empty.failedJobsScanned, 0);
});

test("the comment carries a stable per-SHA marker so re-scans update rather than duplicate", () => {
  const body = renderComment({ headSha: RUN_3444.head_sha, findings: detect({ ...WINDOW, runs: [{ run: RUN_3444, jobs: [VICTIM_3_6] }] }).findings });
  assert.ok(body.startsWith(commentMarkerFor(RUN_3444.head_sha)));
  assert.ok(commentMarkerFor("abc") !== commentMarkerFor("def"));
});

test("the comment names the remedy and forbids the dangerous one", () => {
  const body = renderComment({ headSha: RUN_3444.head_sha, findings: detect({ ...WINDOW, runs: [{ run: RUN_3444, jobs: [VICTIM_3_6] }] }).findings });
  assert.match(body, /not a test failure/i);
  assert.match(body, /gh run rerun 42147146391 --failed/);
  assert.match(body, /Do not push a new head/i);
  // The evidence must be in the comment, not just the conclusion: an author who
  // disagrees needs to be able to check it.
  assert.match(body, /Run grouped general test suites/);
  assert.match(body, /in_progress/);
});

test("findings group by head SHA so one comment covers every false red on a commit", () => {
  const other = { ...VICTIM_3_6, id: 2, name: "General tests (server 6/6)" };
  const v = detect({ ...WINDOW, runs: [{ run: RUN_3444, jobs: [VICTIM_3_6, other] }] });
  const grouped = groupByHeadSha(v.findings);
  assert.equal(grouped.size, 1);
  assert.equal(grouped.get(RUN_3444.head_sha).length, 2);
  const body = renderComment({ headSha: RUN_3444.head_sha, findings: grouped.get(RUN_3444.head_sha) });
  assert.match(body, /2 red checks/);
});

test("parseArgs defaults pad the fetch far enough to reach a long-queued run", () => {
  const a = parseArgs([]);
  assert.equal(a.comment, false);
  assert.equal(a.lookbackMinutes, 60);
  // PR #3444 was created 3h38m before its job failed; the pad must exceed that.
  assert.ok(a.fetchPadMinutes > 3 * 60 + 38);
  assert.equal(parseArgs(["--comment", "true"]).comment, true);
  assert.equal(parseArgs(["--comment", "false"]).comment, false);
});
