// Pins `.planning/ally-agent/AGENTS.md` against the guard's own exported
// constants and against the live operating policy it documents.
//
// IMPORTANT SCOPE NOTE: this file is documentation, not runtime. Ally's live
// instructions are a managed bundle on the paperclip volume, reachable at
// `GET /api/agents/:id/instructions-bundle/file`; nothing in this repository
// syncs this doc into it. So these assertions keep the *document* honest — they
// cannot and do not change agent behaviour.
//
// The two had drifted far enough to contradict each other. This doc last saw a
// substantive edit on 2026-05-16 while the live bundle accumulated dated policy
// through 2026-08-30, and an earlier revision of this doc told Ally to skip
// self-review entirely — the exact over-generalisation the live bundle records
// as false and as having already cost real reviews (BLO-22488, BLO-22493).
// A stale instruction in prose fails silently and reads like working policy,
// which is what these tests exist to prevent.

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

test("the self-review guard requires a COMMENTED review, not a skip", () => {
  const line = agentsDoc.split("\n").find((l) => l.includes("review your own work"));
  assert.ok(line, "the self-review guard must remain present");
  assert.ok(line.includes(ALLY_APP_REVIEWER_LOGIN),
    `the self-review guard must name ${ALLY_APP_REVIEWER_LOGIN}`);

  // The live managed bundle is explicit that self-review is PERMITTED and is the
  // required delivery form: GitHub bars a PR's author from APPROVE and
  // REQUEST_CHANGES, but not from COMMENTED. It records the blanket
  // "the App cannot review its own PR" reading as the self-*approval* bar
  // over-generalised — false, and already responsible for lost reviews
  // (BLO-22488, BLO-22493). An earlier revision of this file encoded exactly
  // that over-generalisation as a skip; this pins it from coming back.
  // Match the DIRECTIVE, not the word: this line has to stay free to say
  // "never a skip" in order to forbid one, so `/\bskip\b/` would fire on the
  // prohibition itself. `author=self` was the actual suppressing instruction.
  assert.doesNotMatch(line, /author=self/i,
    "`author=self, skipping` was the directive that suppressed self-review");
  assert.doesNotMatch(line, /Don't review your own work/i,
    "the blanket prohibition is the over-generalisation the live bundle records"
    + " as false and already costly (BLO-22488, BLO-22493)");
  assert.match(line, /COMMENTED/,
    "the guard must name COMMENTED as the delivery form");
});

// Executable lines only. The surrounding comments have to stay free to NAME the
// anti-patterns in order to explain them, so an assertion over the raw fence
// would fire on the explanation rather than on the command.
function idempotencyCommands() {
  const fence = /```bash\n([\s\S]*?)```/.exec(idempotencyBlock());
  assert.ok(fence, "Step 2 must retain an executable bash block");
  const code = fence[1]
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  assert.match(code, /gh api .*\/reviews/, "the fence must be the reviews query");
  return code;
}

test("idempotency counts only the App identity, not the User seat", () => {
  const code = idempotencyCommands();

  // The `allyblockcast` User seat is a second hat on this same agent, not an
  // independent reviewer — the live bundle says to count only `user.type == Bot`.
  // REST may expose the App's normalized login as bare `allyblockcast`, so
  // matching on login alone silently lets a User-seat review satisfy the skip.
  assert.match(code, /\.user\.type\s*==\s*"Bot"/,
    "the query must gate on user.type == \"Bot\", not on login alone");
});

test("idempotency attests the head from the body, never from commit_id", () => {
  const code = idempotencyCommands();

  // GitHub rewrites review.commit_id after an "Update branch", so a review that
  // attested an older head can start reporting the current one — the skip then
  // fires for a head that was never reviewed. The immutable attestation is the
  // `Reviewed head: <40-hex>` line in the review body.
  assert.match(code, /Reviewed head: /,
    "the query must parse the immutable `Reviewed head:` attestation");
  assert.doesNotMatch(code, /\.commit_id/,
    "commit_id is mutable across Update branch and must not decide idempotency");
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
