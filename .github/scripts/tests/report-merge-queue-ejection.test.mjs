import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeQueuePullRequestNumber,
  shouldReportMergeQueueFailure,
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

test("only failed merge-group runs are reportable", () => {
  assert.equal(shouldReportMergeQueueFailure({
    headBranch: "gh-readonly-queue/master/pr-1306-abc123",
    conclusion: "failure",
  }), true);
  assert.equal(shouldReportMergeQueueFailure({
    headBranch: "gh-readonly-queue/master/pr-1306-abc123",
    conclusion: "success",
  }), false);
  assert.equal(shouldReportMergeQueueFailure({ headBranch: "fix/BLO-1306", conclusion: "failure" }), false);
});
