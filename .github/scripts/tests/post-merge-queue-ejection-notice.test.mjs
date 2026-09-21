import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildEjectionComment,
  parseQueueRef,
} from "../post-merge-queue-ejection-notice.mjs";

// BLO-28886 ask 2. Everything here pins a property that is unobservable until a
// real ejection has already been missed — which is the failure this notifier
// exists to remove, so it cannot be the thing that detects its own regression.

test("parses the PR number out of a real queue ref", () => {
  assert.deepEqual(
    parseQueueRef(
      "gh-readonly-queue/master/pr-1411-1ae5079c2da3e352f2a26b42f0c332a1c8eeda63",
    ),
    { prNumber: 1411 },
  );
});

// The base branch is a path segment and may itself contain slashes, so a naive
// `split('/')[2]` or a non-anchored match reads the wrong segment and the notice
// lands on an unrelated PR — worse than not posting at all.
test("anchors on the last /pr- segment, not the third path segment", () => {
  assert.deepEqual(
    parseQueueRef("gh-readonly-queue/release/v2/pr-1853-9feaa97d0abc1234"),
    { prNumber: 1853 },
  );
});

// A non-queue ref must be a silent no-op: this listener sees every completed PR
// run, and the overwhelming majority are ordinary pull_request runs.
test("returns null for refs that are not merge-queue candidates", () => {
  for (const ref of [
    "master",
    "staff/blo-28886",
    "gh-readonly-queue/master/pr-abc-1ae5079c",
    "gh-readonly-queue/master/nope-1411-1ae5079c",
    "",
    undefined,
    null,
  ]) {
    assert.equal(parseQueueRef(ref), null, `expected null for ${String(ref)}`);
  }
});

// The `gh-readonly-queue/` prefix check is load-bearing on its own: the trailing
// `/pr-<n>-<hex>` shape is not unique to the queue, and an ordinary branch that
// happens to match it would make this notifier post an ejection notice onto an
// unrelated PR that was never ejected. Found by mutation-testing — deleting the
// prefix check passed the whole suite until this case existed.
test("a non-queue branch shaped like a queue ref is still rejected", () => {
  for (const ref of [
    "backport/pr-1411-1ae5079c",
    "gh-readonly-queue-lookalike/master/pr-1411-1ae5079c",
    "pr-1411-1ae5079c",
  ]) {
    assert.equal(parseQueueRef(ref), null, `expected null for ${ref}`);
  }
});

test("names every failing job in the comment", () => {
  const body = buildEjectionComment({
    failedJobs: ["General tests (server 4/4)", "General tests (workspaces-b)"],
    runUrl: "https://github.com/Blockcast/paperclip/actions/runs/32224860384",
    runId: "32224860384",
    headSha: "1ae5079c2da3e352f2a26b42f0c332a1c8eeda63",
  });

  assert.match(body, /General tests \(server 4\/4\)/);
  assert.match(body, /General tests \(workspaces-b\)/);
  assert.match(body, /actions\/runs\/32224860384/);
  // The reader's most likely wrong inference is "my PR is green, so this is
  // stale". Saying why the rollup disagrees is the whole point of the comment.
  assert.match(body, /check rollup/i);
});

// A run can be ejected with zero `failure` jobs (a lane killed mid-run reports
// `cancelled`). Emitting an empty bullet list would read as "nothing failed",
// which is the same false-green this notifier exists to prevent.
test("says so explicitly when no job reported failure", () => {
  const body = buildEjectionComment({
    failedJobs: [],
    runUrl: "https://example.invalid/run",
    runId: "1",
    headSha: "abc123def456",
  });

  assert.match(body, /no job reported/i);
});

// The trust-boundary argument in the workflow header is load-bearing and is not
// enforced by anything else: a later edit adding `ref:` to the checkout would
// run the queue candidate's code with `pull-requests: write`, silently turning
// this notifier into a privilege-escalation path for any queued diff.
test("the workflow never checks out the queue candidate", () => {
  const workflow = readFileSync(
    new URL("../../workflows/merge-queue-ejection-notice.yml", import.meta.url),
    "utf8",
  );

  // Strip comment lines before matching. The header deliberately QUOTES the
  // anti-pattern it forbids, so a `doesNotMatch` over the raw file fails on its
  // own documentation — the same trap recorded in
  // scripts/__tests__/merge-group-concurrency.test.mjs.
  const directives = workflow
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  assert.match(directives, /pull-requests: write/);
  assert.doesNotMatch(
    directives,
    /ref:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha/,
    "checking out the triggering run's head would run candidate code with a write token",
  );
  // Not a merge_group check: it must not be able to eject an entry.
  assert.doesNotMatch(directives, /^\s*merge_group:/m);
});
