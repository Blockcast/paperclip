import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeQueuePullRequestNumber,
  shouldReportMergeQueueFailure,
  shouldReportCancelledRun,
  failingJobSummary,
  runOutcomeText,
  causalJobs,
} from "../report-merge-queue-ejection.mjs";

test("extracts PR numbers from merge-group synthetic refs", () => {
  assert.equal(mergeQueuePullRequestNumber("gh-readonly-queue/master/pr-1306-abc123"), 1306);
  assert.equal(mergeQueuePullRequestNumber("refs/heads/gh-readonly-queue/master/pr-1158-def456"), 1158);
  assert.equal(mergeQueuePullRequestNumber("fix/BLO-1306"), null);
  // The segment anchor is load-bearing: this script POSTS a comment to the number
  // it derives, so an unanchored `pr-` match would comment on an unrelated PR.
  assert.equal(mergeQueuePullRequestNumber("cto/repr-1306-fix"), null);
  assert.equal(mergeQueuePullRequestNumber("fix/pr-notes-1306"), null);
  assert.equal(mergeQueuePullRequestNumber("gh-readonly-queue/master/pr-1306extra"), null);
});

test("failed and cancelled merge-group runs are reportable, nothing else is", () => {
  const branch = "gh-readonly-queue/master/pr-1306-abc123";
  assert.equal(shouldReportMergeQueueFailure({ headBranch: branch, conclusion: "failure" }), true);
  // 14 of the 22 measured `cancelled` runs were ejected and never re-added, and
  // a job timeout surfaces as `cancelled` -- so excluding it missed 15%.
  assert.equal(shouldReportMergeQueueFailure({ headBranch: branch, conclusion: "cancelled" }), true);
  assert.equal(shouldReportMergeQueueFailure({ headBranch: branch, conclusion: "success" }), false);
  // Widening to `!== "success"` would report in-flight and skipped runs.
  assert.equal(shouldReportMergeQueueFailure({ headBranch: branch, conclusion: null }), false);
  assert.equal(shouldReportMergeQueueFailure({ headBranch: branch, conclusion: "skipped" }), false);
  assert.equal(shouldReportMergeQueueFailure({ headBranch: "fix/BLO-1306", conclusion: "failure" }), false);
});

test("a cancelled run is reported only when the PR is neither merged nor still queued", () => {
  assert.equal(shouldReportCancelledRun({ merged: false, isInMergeQueue: false }), true);
  // The group landed: the cancel was collateral, not an ejection.
  assert.equal(shouldReportCancelledRun({ merged: true, isInMergeQueue: false }), false);
  // Still queued for a re-build: not ejected.
  assert.equal(shouldReportCancelledRun({ merged: false, isInMergeQueue: true }), false);
});

test("the ejection comment names the failing shards", () => {
  // Shape taken from the real run that ejected #1962 (35871782486). No
  // timestamps here on purpose: causalJobs() can only prove a lane is
  // downstream from them, so without them it keeps everything and this
  // degrades to naming the aggregator too. Fail-safe direction -- one extra
  // name, never a missing one. The timestamped cases below are the real shape.
  assert.equal(
    failingJobSummary([
      { name: "General tests (workspaces-a)", conclusion: "failure" },
      { name: "General tests (server 1/4)", conclusion: "success" },
      { name: "verify", conclusion: "failure" },
    ]),
    " Failing jobs: `General tests (workspaces-a)`, `verify`.",
  );
  // A job killed by `timeout-minutes` surfaces as cancelled, and that is the
  // class pr.yml deliberately trades a fast red for -- so it must be named too.
  assert.equal(
    failingJobSummary([{ name: "General tests (server 4/4)", conclusion: "cancelled" }]),
    " Failing job: `General tests (server 4/4)`.",
  );
  // Empty, not a dangling "Failing jobs:", when the jobs read gave nothing
  // usable -- the comment must still read as a sentence. Covers the
  // best-effort catch path, which passes no jobs at all.
  assert.equal(failingJobSummary([{ name: "verify", conclusion: "success" }]), "");
  assert.equal(failingJobSummary([]), "");
  assert.equal(failingJobSummary(undefined), "");
});

test("a `cancelled` run carrying a failed job is described as failed, not as a timeout", () => {
  // Shape taken from run 35993984182, which ejected #1976: run-level conclusion
  // `cancelled` (fail-fast cancelled `Build`), but the cause was a genuine
  // `failure` in a shard. Reporting that as "a job timeout surfaces this way"
  // points the reader at infra instead of at the shard.
  assert.equal(
    runOutcomeText("cancelled", [
      { name: "Build", conclusion: "cancelled" },
      { name: "General tests (workspaces-a)", conclusion: "failure" },
      { name: "verify", conclusion: "failure" },
    ]),
    "failed",
  );
  // A genuine timeout: every non-success job is cancelled, nothing failed.
  assert.equal(
    runOutcomeText("cancelled", [
      { name: "General tests (server 4/4)", conclusion: "cancelled" },
      { name: "verify", conclusion: "success" },
    ]),
    "was cancelled (a job timeout surfaces this way)",
  );
  // Degrades to the run-level conclusion when the best-effort jobs read gave
  // nothing -- i.e. exactly the pre-BLO-28886 behaviour, never worse.
  assert.equal(runOutcomeText("cancelled", undefined), "was cancelled (a job timeout surfaces this way)");
  assert.equal(runOutcomeText("failure", undefined), "failed");
});

test("the rendered sentence is coherent on a fail-fast run: no cancelled collateral is named", () => {
  // The two functions above are each correct in isolation while the sentence
  // they compose is wrong -- that split is what hid the `Build` case. So assert
  // on BOTH over ONE real shape: run 35993984182, verbatim from the API.
  // Untimestamped, so `verify` survives; the timestamped form of this same run
  // is asserted below, where it correctly drops to the shard alone.
  const jobs = [
    { name: "Build", conclusion: "cancelled" },
    { name: "General tests (workspaces-a)", conclusion: "failure" },
    { name: "General tests (server 1/4)", conclusion: "success" },
    { name: "verify", conclusion: "failure" },
  ];
  assert.equal(
    `The merge-group run ${runOutcomeText("cancelled", jobs)}.${failingJobSummary(jobs)}`,
    "The merge-group run failed. Failing jobs: `General tests (workspaces-a)`, `verify`.",
  );
  // `Build` was cancelled BECAUSE workspaces-a failed; its log shows only a
  // cancellation. Naming it is the misdirection, not extra detail.
  assert.ok(!failingJobSummary(jobs).includes("Build"));
});

test("a `policy` timeout is named as the cause, not the `verify` lane that merely reports it", () => {
  // Run 35948766367, verbatim from the API: an ejection whose cause is `policy`
  // killed at its 600s cap. `verify` needs: it, so `verify` goes red 14s later
  // and is a genuine `failure` -- which the conclusion filter cannot catch.
  // Before causalJobs() this rendered "The merge-group run failed. Failing job:
  // `verify`.", sending the reader to a log reading only "upstream lane(s) did
  // not run". 2 of the 7 merge-group ejections in the 2026-09-23/25 window.
  const jobs = [
    { name: "policy", conclusion: "cancelled", started_at: "2026-09-24T02:57:04Z", completed_at: "2026-09-24T03:08:22Z" },
    { name: "verify", conclusion: "failure", started_at: "2026-09-24T03:08:36Z", completed_at: "2026-09-24T03:08:47Z" },
  ];
  assert.equal(
    `The merge-group run ${runOutcomeText("cancelled", jobs)}.${failingJobSummary(jobs)}`,
    "The merge-group run was cancelled (a job timeout surfaces this way). Failing job: `policy`.",
  );
});

test("a late-starting second failure is still named: only a job after ALL others is dropped", () => {
  // The narrowness guard. `Build` starts before `workspaces-a` finishes, so it
  // is not downstream-of-everything and must survive causalJobs() -- it is then
  // dropped as fail-fast collateral by the conclusion filter, which is a
  // different rule. Widening causalJobs to "after SOME other job" would drop a
  // genuine independent failure that merely started late.
  const jobs = [
    { name: "Build", conclusion: "cancelled", started_at: "2026-09-24T11:46:54Z", completed_at: "2026-09-24T12:12:33Z" },
    { name: "General tests (workspaces-a)", conclusion: "failure", started_at: "2026-09-24T11:45:42Z", completed_at: "2026-09-24T12:05:41Z" },
    { name: "verify", conclusion: "failure", started_at: "2026-09-24T13:36:47Z", completed_at: "2026-09-24T13:37:41Z" },
  ];
  assert.deepEqual(causalJobs(jobs).map((job) => job.name), ["Build", "General tests (workspaces-a)"]);
  assert.equal(
    `The merge-group run ${runOutcomeText("cancelled", jobs)}.${failingJobSummary(jobs)}`,
    "The merge-group run failed. Failing job: `General tests (workspaces-a)`.",
  );
});

test("a lone failing job is never dropped for being vacuously last", () => {
  const jobs = [{ name: "e2e", conclusion: "failure", started_at: "2026-09-24T11:45:42Z", completed_at: "2026-09-24T12:05:41Z" }];
  assert.equal(failingJobSummary(jobs), " Failing job: `e2e`.");
  // Jobs with no timestamps at all (never dispatched) must not vanish either.
  assert.equal(failingJobSummary([{ name: "policy", conclusion: "cancelled" }]), " Failing job: `policy`.");
});

test("a job that started after SOME but not ALL others is kept (guards the narrowness of causalJobs)", () => {
  // The `every` in causalJobs has to be `every`, not `some`. `b` starts after
  // `a` finished but while `c` is still running, so it is NOT last and is a
  // genuine independent failure. Under a `some` test it would silently vanish
  // from the comment. The fail-fast fixture above cannot catch this -- no job
  // in it starts after any other one completes -- which is why the widened
  // form passed the suite before this test existed.
  const jobs = [
    { name: "a", conclusion: "failure", started_at: "2026-09-24T10:00:00Z", completed_at: "2026-09-24T10:10:00Z" },
    { name: "b", conclusion: "failure", started_at: "2026-09-24T10:15:00Z", completed_at: "2026-09-24T10:40:00Z" },
    { name: "c", conclusion: "failure", started_at: "2026-09-24T10:05:00Z", completed_at: "2026-09-24T10:50:00Z" },
  ];
  assert.deepEqual(causalJobs(jobs).map((job) => job.name), ["a", "b", "c"]);
});

test("jobs cancelled at the same instant are all reported, not all dropped", () => {
  // Reachability of the `causal.length ? causal : list` fallback. Job timestamps
  // are second-resolution, so two lanes cancelled together when the run died
  // carry identical values -- each then reads as "started after the other
  // finished" and both get dropped, leaving the comment naming nothing at all.
  // Observed shape: needs:-gated lanes cancelled 0s after creation.
  const jobs = [
    { name: "Build", conclusion: "cancelled", started_at: "2026-09-24T10:00:00Z", completed_at: "2026-09-24T10:00:00Z" },
    { name: "e2e", conclusion: "cancelled", started_at: "2026-09-24T10:00:00Z", completed_at: "2026-09-24T10:00:00Z" },
  ];
  assert.equal(failingJobSummary(jobs), " Failing jobs: `Build`, `e2e`.");
});
