#!/usr/bin/env node

/**
 * Chooses which duplicate Ally review to dismiss — and, more to the point,
 * which one must NOT be dismissed.
 *
 * `check-ally-review-consistency.mjs` invariant I1 caps operative App-lane
 * reviews at one per (PR, head). It says nothing about how a violation is
 * *remedied*, and the obvious remedy is wrong. GitHub derives
 * `reviewDecision` from each reviewer's **latest** review, so dismissing the
 * newer of two duplicates leaves DISMISSED as the reviewer's latest state and
 * makes the retained approval inert — I1 satisfied, PR unmergeable.
 *
 * Measured on Blockcast/onprem-k8s#3281 @ b108db2 (BLO-32837): two wakes for
 * one head produced reviews 5146530564 (20:10:12Z) and 5146534396 (20:10:36Z),
 * both APPROVED. The cleanup dismissed 5146534396 — the newer — and the PR
 * went to `reviewDecision=REVIEW_REQUIRED` / `mergeStateStatus=BLOCKED` with
 * `latestReviews=[DISMISSED]` and `latestOpinionatedReviews=[]`. It needed
 * `gh pr merge --admin` despite carrying a real, retained Ally approval.
 *
 * Three deliberate properties:
 *
 *   1. Candidates are matched on the **body attestation**, never `commit_id`.
 *      GitHub re-anchors `commit_id` forward on APPROVED reviews when the
 *      branch is updated (BLO-34581), and APPROVED is exactly the state being
 *      de-duplicated here, so `commit_id` both admits reviews that never read
 *      this head and hides ones that did.
 *
 *   2. Conflicting verdicts are refused, not resolved. Two runs reaching
 *      opposite conclusions at one head (BLO-19778, #876) is a supersession
 *      decision with a blocker behind it — see the merge-token dismissal step
 *      in the Ally bundle — not a duplicate. Silently dismissing one side
 *      would pick a winner by clock order.
 *
 *   3. Unorderable input is refused. If "newest" cannot be established the
 *      failure mode is precisely the defect above, so this fails closed and
 *      dismisses nothing.
 *
 * Seat-lane reviews are never candidates. R4 (BLO-24056) bars the seat from
 * submitting a review at all, so a seat review is an I6 violation to report,
 * not a duplicate to tidy away.
 */

import { allyReviewLane, attestedHead, isMainModule } from "./check-ally-review-consistency.mjs";

const OPERATIVE_EXCLUDED_STATES = new Set(["DISMISSED", "PENDING"]);

function reviewState(review) {
  return String(review?.state ?? "UNKNOWN").toUpperCase();
}

function submittedAt(review) {
  return Date.parse(review?.submitted_at ?? "");
}

/**
 * Operative App-lane Ally reviews whose body attests `headSha`.
 *
 * Mirrors `operativeAllyReviews` except for the matching key: that one groups
 * by `commit_id` because I3 separately asserts the two agree, and a
 * disagreement there is the violation it wants to report. Here a disagreement
 * must not be reported, it must be survived — so the immutable field wins.
 */
export function exactHeadAppReviews(reviews, headSha) {
  // No shape check on `headSha`: `attestedHead` only ever yields a 40-hex
  // string or null, so comparing against it already rejects an abbreviated,
  // empty, or over-long head by returning no candidates. A regex here looked
  // like a guard but could not change any outcome — mutation-testing it
  // survived, which is how it was found.
  const head = String(headSha ?? "").toLowerCase();
  return (reviews ?? []).filter(
    (review) =>
      allyReviewLane(review?.user) === "app" &&
      !OPERATIVE_EXCLUDED_STATES.has(reviewState(review)) &&
      attestedHead(review?.body) === head,
  );
}

/**
 * Decide the duplicate-cleanup action for one (PR, head).
 *
 * Returns `{ reason, retain, dismiss }`. `dismiss` is always empty unless
 * `reason === "duplicate"`, and never contains the newest candidate.
 *
 *   none                  — no operative exact-head App review.
 *   no-duplicate          — exactly one; nothing to clean up.
 *   conflicting-verdicts  — candidates disagree; a supersession decision.
 *   unorderable           — a candidate carries no parseable `submitted_at`.
 *   duplicate             — same verdict twice or more; retain newest.
 */
export function selectDuplicateDismissals(reviews, headSha) {
  const candidates = exactHeadAppReviews(reviews, headSha);
  if (candidates.length === 0) return { reason: "none", retain: null, dismiss: [] };
  if (candidates.length === 1) {
    return { reason: "no-duplicate", retain: candidates[0], dismiss: [] };
  }

  const states = new Set(candidates.map(reviewState));
  if (states.size > 1) {
    return { reason: "conflicting-verdicts", retain: null, dismiss: [] };
  }
  if (candidates.some((review) => Number.isNaN(submittedAt(review)))) {
    return { reason: "unorderable", retain: null, dismiss: [] };
  }

  const newestFirst = [...candidates].sort(
    (a, b) => submittedAt(b) - submittedAt(a) || Number(b.id) - Number(a.id),
  );
  return { reason: "duplicate", retain: newestFirst[0], dismiss: newestFirst.slice(1) };
}

async function main() {
  const head = process.argv[2];
  if (!head) {
    process.stderr.write(
      "usage: gh api repos/O/R/pulls/N/reviews --paginate | ally-review-de-dupe.mjs <full-40-hex-head>\n",
    );
    process.exitCode = 2;
    return;
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const decision = selectDuplicateDismissals(JSON.parse(chunks.join("") || "[]"), head);
  const brief = ({ id, state, submitted_at: at }) => ({ id, state, submitted_at: at });
  process.stdout.write(
    `${JSON.stringify(
      {
        reason: decision.reason,
        retain: decision.retain ? brief(decision.retain) : null,
        dismiss: decision.dismiss.map(brief),
      },
      null,
      2,
    )}\n`,
  );
}

// `import.meta.url` must be passed explicitly: isMainModule's default
// parameter is evaluated in the module that DEFINES it, so a bare
// isMainModule() here compares argv[1] against check-ally-review-consistency's
// own URL and is false forever — the CLI exits 0 having printed nothing.
if (isMainModule(process.argv[1], import.meta.url)) {
  await main();
}
