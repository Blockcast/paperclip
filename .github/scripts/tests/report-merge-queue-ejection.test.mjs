import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeQueuePullRequestNumber,
  shouldReportMergeQueueFailure,
  shouldReportCancelledRun,
  failingJobSummary,
  runOutcomeText,
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
  // Shape taken from the real run that ejected #1962 (35871782486): the
  // aggregator `verify` fails alongside the shard, and is deliberately kept.
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
