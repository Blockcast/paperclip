import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf8");

function extractBlock(startMarker, endMarker) {
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker ${startMarker}`);
  const end = workflow.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing marker ${endMarker}`);
  return workflow.slice(start, end);
}

// BLO-22902: `merge_group.base_ref` is a constant (`refs/heads/master`), so it
// collapses every merge-group build into one cancel-in-progress slot. That is
// invisible at maximumEntriesToBuild=1 and silently defeats any raise above 1 --
// the queue head's build gets cancelled by the entry staged behind it.
//
// This assertion used to pin `base_ref` on the premise that the concurrency key
// was what superseded a re-staged generation. Measured 2026-09-13, it is not:
// GitHub cancels a destroyed merge group's runs itself (run 08:48:57Z,
// pr-1770-2ace7b68, cancelled 09:05:23Z -- 73s before any successor run
// existed, so no concurrency rule could have done it).
//
// Pinning the whole expression is what excludes `base_ref`; a `doesNotMatch`
// cannot be used here because the block includes the comment above the key,
// which names the anti-pattern it forbids.
test("merge-group builds are keyed per queue entry, not per base branch", () => {
  const concurrency = extractBlock("\nconcurrency:\n", "\nenv:\n");

  assert.match(
    concurrency,
    /group: pr-\$\{\{ github\.event\.pull_request\.number \|\| github\.event\.merge_group\.head_ref \|\| github\.run_id \}\}/,
    "concurrency.group must key merge_group on head_ref, which is unique per queue entry and per re-staged generation",
  );
  assert.match(concurrency, /cancel-in-progress: true/);
});

test("merge-group control gates use the dedicated queue runner pool", () => {
  const runnerExpression =
    /runs-on: \$\{\{ github\.event_name == 'merge_group' && 'arc-merge-queue' \|\| 'arc-light' \}\}/;
  const jobs = [
    extractBlock("\n  policy:\n", "\n  helm_chart:\n"),
    extractBlock("\n  helm_chart:\n", "\n  typecheck_release_registry:\n"),
    extractBlock("\n  verify:\n", "\n  build:\n"),
  ];

  for (const job of jobs) assert.match(job, runnerExpression);
});

test("policy CI pins the merge-group concurrency contract", () => {
  const policy = extractBlock("\n  policy:\n", "\n  helm_chart:\n");

  assert.match(
    policy,
    /- name: Test merge-group concurrency key\n(?:        if: \$\{\{ !cancelled\(\) \}\}\n)?        run: node --test \.\/scripts\/__tests__\/merge-group-concurrency\.test\.mjs/,
  );
});
