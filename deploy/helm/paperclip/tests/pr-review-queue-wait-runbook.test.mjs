// BLO-41442: the bound check in runbooks/pr-review-queue-wait.md -- the
// runbook PaperclipPrReviewQueueWaitSaturated links to (prometheus-rule.test.mjs
// pins that runbook_url) -- must not hand its two instrument failures the same
// verdict. onprem-k8s#5124 puts `or vector(0)` on both the bucket and `_sum`
// arms, and they mean opposite things for the queue:
//
//   - le drift: the bucket arm falls to vector(0), the fraction reads 1.0
//     whatever the queue does, so the page itself is an artefact;
//   - missing `_sum`: the gate is computed from `_bucket` and `_count` alone,
//     so the breach is real and only the 0s magnitude is broken.
//
// A single "points at the instrument, not the queue" sentence covering both
// stands an operator down on a real breach. Even on its own, le drift only
// breaks the page: the queue can still be saturated, and query 2's mean
// (`_sum`/`_count`, no `le` label) survives the drift. So every branch must send
// the operator back to the queue, and the le-drift branch must do it through
// query 2. That is asserted positively: a phrase ban on the stand-down cannot
// work, because a correctly scoped verdict ("a verdict on the page, not on the
// queue, which can still be saturated") shares the stand-down's words. Pure
// text test: it reads the runbook and nothing else.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const runbook = readFileSync(
  new URL("../../../../runbooks/pr-review-queue-wait.md", import.meta.url),
  "utf8",
);

// Paragraphs and list items between the bound check's lead and step (a): the
// units an operator reads a verdict from.
function boundCheckBlocks() {
  const start = runbook.indexOf("**Read the two together before triaging the queue.**");
  const end = runbook.indexOf("**(a) ", start);
  assert.ok(start !== -1 && end > start, "bound-check block not found; re-anchor this test");
  return runbook
    .slice(start, end)
    .split(/\n\s*\n|\n(?=- )/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// The verdict branches: the bound check's list items, one per instrument failure.
function branches() {
  const items = boundCheckBlocks().filter((b) => b.startsWith("- "));
  assert.equal(items.length, 3, "expected three bound-check branches; re-anchor this test");
  return items;
}

function assertEachBranchSendsToQueue(items) {
  for (const branch of items) {
    assert.match(branch, /\b(?:triage|judge) the queue\b/, `branch stands the operator down: ${branch}`);
  }
}

test("every verdict branch sends the operator back to the queue", () => {
  assertEachBranchSendsToQueue(branches());
});

test("must-fail: a branch reduced to a stand-down fails however it is spelled", () => {
  const items = branches();
  for (const [i, branch] of items.entries()) {
    for (const standDown of ["not the queue", "not on the queue", "not **on** the queue"]) {
      const cut = branch.replace(/^(- \*\*[^*]+\*\*).*$/, `$1 This points at the instrument, ${standDown}.`);
      assert.notEqual(cut, branch, `branch ${i} heading not found; re-anchor this test`);
      assert.throws(
        () => assertEachBranchSendsToQueue(items.with(i, cut)),
        assert.AssertionError,
        `guard passed branch ${i} spelled "${standDown}"`,
      );
    }
  }
});

test("the le-drift branch checks the queue through query 2 before standing down", () => {
  const leBranch = boundCheckBlocks().filter((b) => b.includes("Query 1 returns empty"));
  assert.equal(leBranch.length, 1, "expected exactly one block for the le-drift (query 1 empty) case");
  assert.match(leBranch[0], /Query 2/);
  assert.match(leBranch[0], /unaffected by `le` drift/);
  assert.match(leBranch[0], /triage the queue/);
});

test("the missing-_sum / 0s case says the breach is real and to triage the queue", () => {
  const sumBranch = boundCheckBlocks().filter((b) => /\b0s\b/.test(b) && b.includes("`_sum`"));
  assert.equal(sumBranch.length, 1, "expected exactly one block for the 0s / missing-_sum case");
  assert.match(sumBranch[0], /breach is real/);
  assert.match(sumBranch[0], /triage the queue/);
});

test("the partial-arm case sends both outcomes back to the queue", () => {
  const partial = branches().filter((b) => b.includes("short `_bucket`") && b.includes("short `_sum`"));
  assert.equal(partial.length, 1, "expected exactly one block for the partial-arm case");
  assert.match(partial[0], /short `_bucket`[^.]*the queue can still be saturated/);
  assert.match(partial[0], /judge the queue on that fraction/);
  assert.match(partial[0], /short `_sum`[^.]*breach is real: file the instrument bug and triage the queue/);
});
