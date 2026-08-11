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

test("merge-group re-stages share one concurrency group per base queue", () => {
  const concurrency = extractBlock("\nconcurrency:\n", "\nenv:\n");

  assert.match(
    concurrency,
    /group: pr-\$\{\{ github\.event\.pull_request\.number \|\| github\.event\.merge_group\.base_ref \|\| github\.run_id \}\}/,
  );
  assert.doesNotMatch(
    concurrency,
    /merge_group\.head_sha/,
    "a composed merge-group SHA changes on every re-stage and cannot cancel older generations",
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
    /- name: Test merge-group concurrency key\n        run: node --test \.\/scripts\/__tests__\/merge-group-concurrency\.test\.mjs/,
  );
});
