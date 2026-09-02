// The Ally agent's Step 2 idempotency check lives in a markdown instruction
// file, but it depends on a constant that lives in code: the login the guard
// treats as the canonical Ally App reviewer. Nothing linked the two, so when
// the instruction referenced `ally-paperclip[bot]` — a login that has never
// posted a review in this repo — the check silently matched nothing,
// `LAST_REVIEW_SHA` was always empty, the skip never fired, and every wake
// re-reviewed the same head. That produced the duplicate operative reviews
// `one-verdict-per-head` has been failing on since 2026-08-28.
//
// A stale identifier in prose fails silently and looks exactly like working
// code, so this pins the instruction against the guard's own exported
// constants. If either side is renamed, this test fails instead of the agent
// quietly re-reviewing forever.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALLY_APP_REVIEWER_LOGIN,
  ALLY_USER_REVIEWER_LOGIN,
} from "./check-ally-review-consistency.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const agentsDoc = readFileSync(join(here, "../.planning/ally-agent/AGENTS.md"), "utf8");

// Step 2 only. Scoping to the block keeps an unrelated mention of a login
// elsewhere in the document from satisfying these assertions.
function idempotencyBlock() {
  const start = agentsDoc.indexOf("### Step 2 — Idempotency check");
  assert.notEqual(start, -1, "AGENTS.md must retain a Step 2 idempotency check");
  const end = agentsDoc.indexOf("### Step 3", start);
  assert.notEqual(end, -1, "Step 2 must be delimited by Step 3");
  return agentsDoc.slice(start, end);
}

test("the idempotency check matches the login that actually posts reviews", () => {
  const block = idempotencyBlock();

  // Positive control first: prove the extraction found real content, so a
  // silently-empty block cannot make the assertions below vacuously pass.
  assert.match(block, /gh api .*\/reviews/,
    "Step 2 must still query the reviews API");

  assert.ok(block.includes(ALLY_APP_REVIEWER_LOGIN),
    `Step 2 must filter on ${ALLY_APP_REVIEWER_LOGIN} — the guard's canonical App`
    + " reviewer. A login that never posts reviews matches nothing, so the check"
    + " passes vacuously and every wake re-reviews.");

  assert.ok(block.includes(ALLY_USER_REVIEWER_LOGIN),
    `Step 2 must also cover the ${ALLY_USER_REVIEWER_LOGIN} User seat`);

  assert.doesNotMatch(block, /ally-paperclip\[bot\]/,
    "ally-paperclip[bot] has never posted a review in this repo; matching it"
    + " is what made the check inert");
});

test("no wake reason exempts the same-head check", () => {
  const block = idempotencyBlock();

  // Invariant I1 permits at most one operative App review per head, so a
  // same-head re-review violates by construction regardless of trigger — and
  // a COMMENTED review cannot be dismissed via the API, so each violation is
  // permanent until that head moves.
  assert.doesNotMatch(block, /always re-review/i,
    "an unconditional re-review clause defeats the check it sits under");
  assert.doesNotMatch(block, /regardless of SHA/i,
    "no wake reason may bypass the same-SHA guard");
});

test("no stale reviewer identity survives anywhere in the document", () => {
  // Scoping the login assertion to Step 2 was right for the command checks —
  // the prose has to stay free to NAME an anti-pattern in order to explain it
  // — but it left the same stale identity live elsewhere. `ally-paperclip[bot]`
  // also appeared in the "don't review your own work" guard at the bottom of
  // the file, so that guard matched nothing either and Ally self-reviewed its
  // own App-authored PRs. One dead identifier, two disabled guards.
  //
  // This is deliberately file-wide: the failure mode is an identity that does
  // not exist, and there is no legitimate reason to name it anywhere.
  assert.doesNotMatch(agentsDoc, /ally-paperclip\[bot\]/,
    "ally-paperclip[bot] is not an identity in this org — every guard naming it"
    + " matches nothing and fails open");

  // Positive control: prove the document was actually loaded, so the absence
  // assertion above cannot pass on an empty read.
  assert.ok(agentsDoc.length > 1000, "AGENTS.md must have been read");
  assert.ok(agentsDoc.includes(ALLY_APP_REVIEWER_LOGIN),
    "the canonical App login must appear somewhere in the document");
});

test("the self-review guard names the identities Ally actually authors under", () => {
  const line = agentsDoc.split("\n").find((l) => l.includes("Don't review your own work"));
  assert.ok(line, "the self-review guard must remain present");
  assert.ok(line.includes(ALLY_APP_REVIEWER_LOGIN),
    `the self-review guard must name ${ALLY_APP_REVIEWER_LOGIN}`);
  assert.ok(line.includes(`\`${ALLY_USER_REVIEWER_LOGIN}\``),
    `the self-review guard must also cover the ${ALLY_USER_REVIEWER_LOGIN} seat`);
});

test("the skip path posts a comment, not a review", () => {
  const block = idempotencyBlock();

  // Scoped to the executable fence on purpose: the surrounding prose has to be
  // free to NAME the anti-pattern in order to explain it, and an absence check
  // over the whole section would fire on that explanation rather than on real
  // behaviour. What must not contain `gh pr review --comment` is the code.
  const fence = /```bash\n([\s\S]*?)```/.exec(block);
  assert.ok(fence, "Step 2 must retain an executable bash block");
  const code = fence[1];

  // Positive control: the extracted fence is the idempotency snippet, so the
  // absence assertion below cannot pass simply by matching an empty string.
  assert.match(code, /gh api .*\/reviews/, "the fence must be the reviews query");

  // `gh pr review --comment` files a PullRequestReview, which the guard counts
  // as a second operative review — so "just leaving a note" through the review
  // API recreates the violation the skip exists to avoid.
  assert.match(code, /gh pr comment/,
    "the skip path must use `gh pr comment`");
  assert.doesNotMatch(code, /gh pr review[^\n]*--comment/,
    "the review API files a review object and recreates the violation");
});
