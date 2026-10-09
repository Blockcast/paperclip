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
// stands an operator down on a real breach. Pure text test: it reads the
// runbook and nothing else.
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

test("the instrument-only verdict never covers the missing-_sum / 0s case", () => {
  const instrumentOnly = boundCheckBlocks().filter((b) => b.includes("not the queue"));
  assert.ok(instrumentOnly.length > 0, "le-drift branch must still say it points at the instrument, not the queue");
  for (const block of instrumentOnly) {
    assert.doesNotMatch(block, /`_sum`|\b0s\b/, `instrument-only verdict also covers _sum: ${block}`);
  }
});

test("the missing-_sum / 0s case says the breach is real and to triage the queue", () => {
  const sumBranch = boundCheckBlocks().filter((b) => /\b0s\b/.test(b) && b.includes("`_sum`"));
  assert.equal(sumBranch.length, 1, "expected exactly one block for the 0s / missing-_sum case");
  assert.match(sumBranch[0], /breach is real/);
  assert.match(sumBranch[0], /triage the queue/);
});
