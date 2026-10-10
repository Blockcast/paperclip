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
// (`_sum`/`_count`, no `le` label) survives the drift. So no branch may end on
// "not the queue"; the le-drift branch must send the operator to query 2 and
// the queue instead. Pure text test: it reads the runbook and nothing else.
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

test("no instrument branch stands the operator down on the queue", () => {
  for (const block of boundCheckBlocks()) {
    assert.doesNotMatch(block, /not the queue/, `bare stand-down on the queue: ${block}`);
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
