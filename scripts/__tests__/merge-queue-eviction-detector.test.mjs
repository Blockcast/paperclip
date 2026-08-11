import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRunSearchWindow,
  classifyMergeQueueEviction,
  filterMergeGroupRunsForPr,
  mergeQueueHeadBranchPrefix,
  selectLatestQueueAttemptWindow,
} from "../merge-queue-eviction-detector.mjs";

test("classifies zero merge_group runs as conflict_unstageable, not check_failure", () => {
  // BLO-23395: PR #1092's exact incident shape -- added to the queue,
  // evicted 4.5h later, and zero merge_group runs were ever created for it.
  const classification = classifyMergeQueueEviction({ merged: false, mergeGroupRuns: [] });
  assert.equal(classification, "conflict_unstageable");
  assert.notEqual(classification, "check_failure");
});

test("classifies a failing merge_group run as check_failure", () => {
  const classification = classifyMergeQueueEviction({
    merged: false,
    mergeGroupRuns: [{ conclusion: "success" }, { conclusion: "failure" }],
  });
  assert.equal(classification, "check_failure");
});

test("classifies a non-failing merge_group run with no merge as manual", () => {
  const classification = classifyMergeQueueEviction({
    merged: false,
    mergeGroupRuns: [{ conclusion: "success" }],
  });
  assert.equal(classification, "manual");
});

test("classifies a stuck-in-progress run (never reaches a conclusion) that was dequeued as manual, not check_failure", () => {
  // The runbook's existing "stalled head" shape: a merge_group run exists but
  // never terminates, so an SRE manually dequeues it. That is not a check
  // failure -- no check ever concluded failing.
  const classification = classifyMergeQueueEviction({
    merged: false,
    mergeGroupRuns: [{ conclusion: null, status: "in_progress" }],
  });
  assert.equal(classification, "manual");
});

test("classifies merged PRs as merged regardless of run history", () => {
  const classification = classifyMergeQueueEviction({
    merged: true,
    mergeGroupRuns: [],
  });
  assert.equal(classification, "merged");
});

test("classifies a truncated empty sample as unknown, not conflict_unstageable (Ally review #1220)", () => {
  // A `gh run list` sample that hit its cap is not proof of absence -- on a
  // busy repo, this PR's own merge_group run could sit beyond the cap. Only
  // report conflict_unstageable when the empty result is known-complete.
  const classification = classifyMergeQueueEviction({ merged: false, mergeGroupRuns: [], truncated: true });
  assert.equal(classification, "unknown");
  assert.notEqual(classification, "conflict_unstageable");
});

test("a truncated sample with a real match still classifies normally", () => {
  // Truncation only matters when it could be hiding this PR's run; once a
  // match is actually found, the sample answered the question either way.
  const classification = classifyMergeQueueEviction({
    merged: false,
    mergeGroupRuns: [{ conclusion: "failure" }],
    truncated: true,
  });
  assert.equal(classification, "check_failure");
});

test("mergeQueueHeadBranchPrefix matches GitHub's gh-readonly-queue naming", () => {
  assert.equal(mergeQueueHeadBranchPrefix("master", 1092), "gh-readonly-queue/master/pr-1092-");
});

test("filterMergeGroupRunsForPr excludes runs for other PRs, including numeric-prefix collisions", () => {
  const runs = [
    { headBranch: "gh-readonly-queue/master/pr-1092-abc123", conclusion: "success" },
    // Must NOT match PR 1092 despite sharing the "pr-1092" substring.
    { headBranch: "gh-readonly-queue/master/pr-10920-def456", conclusion: "failure" },
    { headBranch: "gh-readonly-queue/master/pr-961-ghi789", conclusion: "success" },
    { headBranch: "refs/heads/master", conclusion: null },
  ];
  const matched = filterMergeGroupRunsForPr(runs, { base: "master", prNumber: 1092 });
  assert.equal(matched.length, 1);
  assert.equal(matched[0].headBranch, "gh-readonly-queue/master/pr-1092-abc123");
});

test("filterMergeGroupRunsForPr on an empty run list returns empty, driving conflict_unstageable end to end", () => {
  // Replays the #1092 incident shape: enumerate every merge_group run in the
  // window (pr-1165, pr-961, pr-1046, pr-1011, pr-988, pr-900, pr-1163,
  // pr-1162, pr-1127 -- no pr-1092) and confirm the detector's full pipeline
  // (filter -> classify) lands on conflict_unstageable.
  const runs = [
    "pr-1165", "pr-961", "pr-1046", "pr-1011", "pr-988", "pr-900", "pr-1163", "pr-1162", "pr-1127",
  ].map((label, i) => ({
    headBranch: `gh-readonly-queue/master/${label}-${"a".repeat(7)}${i}`,
    conclusion: "success",
  }));
  const matched = filterMergeGroupRunsForPr(runs, { base: "master", prNumber: 1092 });
  assert.equal(matched.length, 0);
  assert.equal(classifyMergeQueueEviction({ merged: false, mergeGroupRuns: matched }), "conflict_unstageable");
});

test("selectLatestQueueAttemptWindow picks the most recent enqueue/dequeue pair for a re-queued PR (Ally review #1220)", () => {
  // A PR dequeued once for a failing check, manually re-added, then evicted
  // again for an un-stageable rebase must not have its first attempt's runs
  // leak into the second attempt's classification.
  const events = [
    { event: "added_to_merge_queue", created_at: "2026-08-08T09:00:00Z" },
    { event: "removed_from_merge_queue", created_at: "2026-08-08T09:10:00Z" },
    { event: "added_to_merge_queue", created_at: "2026-08-08T09:24:35Z" },
    { event: "removed_from_merge_queue", created_at: "2026-08-08T13:55:45Z" },
  ];
  const window = selectLatestQueueAttemptWindow(events, { now: Date.parse("2026-08-08T14:00:00Z") });
  assert.deepEqual(window, {
    enqueuedAt: "2026-08-08T09:24:35.000Z",
    dequeuedAt: "2026-08-08T13:55:45.000Z",
  });
});

test("selectLatestQueueAttemptWindow is unaffected by event order in the input array", () => {
  const events = [
    { event: "removed_from_merge_queue", created_at: "2026-08-08T13:55:45Z" },
    { event: "added_to_merge_queue", created_at: "2026-08-08T09:24:35Z" },
    { event: "removed_from_merge_queue", created_at: "2026-08-08T09:10:00Z" },
    { event: "added_to_merge_queue", created_at: "2026-08-08T09:00:00Z" },
  ];
  const window = selectLatestQueueAttemptWindow(events, { now: Date.parse("2026-08-08T14:00:00Z") });
  assert.deepEqual(window, {
    enqueuedAt: "2026-08-08T09:24:35.000Z",
    dequeuedAt: "2026-08-08T13:55:45.000Z",
  });
});

test("selectLatestQueueAttemptWindow falls back to `now` when still enqueued (no matching removal yet)", () => {
  const events = [{ event: "added_to_merge_queue", created_at: "2026-08-08T09:24:35Z" }];
  const now = Date.parse("2026-08-08T09:30:00Z");
  const window = selectLatestQueueAttemptWindow(events, { now });
  assert.equal(window.enqueuedAt, "2026-08-08T09:24:35.000Z");
  assert.equal(window.dequeuedAt, new Date(now).toISOString());
});

test("selectLatestQueueAttemptWindow returns null when no added_to_merge_queue event exists", () => {
  const window = selectLatestQueueAttemptWindow(
    [{ event: "labeled", created_at: "2026-08-08T09:00:00Z" }],
    { now: Date.now() },
  );
  assert.equal(window, null);
});

test("buildRunSearchWindow buffers the window by 5 minutes on each side", () => {
  const range = buildRunSearchWindow({
    enqueuedAt: "2026-08-08T09:24:35.000Z",
    dequeuedAt: "2026-08-08T13:55:45.000Z",
  });
  assert.equal(range, "2026-08-08T09:19:35.000Z..2026-08-08T14:00:45.000Z");
});
