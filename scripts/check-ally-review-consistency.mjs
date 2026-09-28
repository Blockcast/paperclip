#!/usr/bin/env node

/**
 * Guards the integrity of Ally's GitHub review attestations.
 *
 * Ally composes a consolidated review body and posts it with `gh pr review`.
 * Nothing server-side enforces one verdict per head, and several independent
 * wake sources (marker comment, ready_for_review toggle, and review-request
 * issue assignment) can each launch a run for the same PR. Review evidence
 * comes from one lane only: the Ally App's formal review. The `allyblockcast`
 * User seat is a second hat on the same agent, so R4 (BLO-24056) retired it as
 * evidence entirely — see I6. Reviews still arrive on both lanes, so both are
 * parsed; only the App lane can carry a verdict.
 *
 * Observed on Blockcast/paperclip#876 (BLO-19778): two runs dispatched 43 ms
 * apart both submitted at head ff1c72db, 34 s apart, with opposite verdicts.
 *
 *   I1  At most one operative review per lane per (PR, head SHA). A same-lane
 *       duplicate also reports whether the bodies are identical or differ
 *       (`sameLaneBodyRelation`), because that — not the gap between
 *       submissions — is what says whether the missing control is submit
 *       idempotency or reviewer exclusion.
 *
 *       Three arms here can only fire when an operative seat review exists —
 *       I1 over the seat lane, I1 for one body submitted under two
 *       credentials, and I2b — so I6 already fires wherever they do. They are
 *       retained as subsumed diagnostics that add detail to a seat violation,
 *       not as independent policy: do not read them as evidence that the seat
 *       lane still carries a permitted shape.
 *   I2  No operative APPROVED review whose own body reports a Critical or
 *       Important finding, no User-seat APPROVED review coexisting with a
 *       blocking App review, and no App approval without a `Reviewed head:`
 *       attestation.
 *   I3  An operative App review has exactly one canonical body and its
 *       body-attested `Reviewed head:` matches the commit GitHub recorded it
 *       against.
 *   I4  A clean App verdict is a formal `APPROVED` review. The sole exception
 *       is an App-authored PR: GitHub prevents the App from approving its own
 *       PR, so its clean canonical self-review is necessarily `COMMENTED`. A
 *       clean App `COMMENTED` review cannot satisfy the App lane for any
 *       independently authored PR.
 *   I5  A review using an Ally canonical login and account type must also
 *       carry the immutable REST ID for that principal. A lookalike identity
 *       must never become valid evidence merely by copying the login string.
 *   I6  No operative User-seat review at all. R4 (BLO-24056, ratified on
 *       BLO-29559) made the seat a flat prohibition: it shares a login with
 *       the authoring App, so a seat verdict is self-approval wearing a second
 *       hat. An earlier revision of this file treated the seat as a second
 *       lane of "human evidence" that "may use plain exact-head prose" and so
 *       need not attest a head — which is exactly why BLO-22916 Defect 2, five
 *       content-free seat APPROVEDs carrying no `Reviewed head:` line, was
 *       invisible to every check here.
 *
 * On I3's mechanism. An earlier revision of this file said `gh pr review`
 * binds a review to the head at submit time, so a mid-review push "certifies a
 * tree that was never read". Submit-time binding is real but it is not what
 * produces most I3 hits, and the difference matters because the old wording
 * blamed the reviewer for a value the reviewer never set. Measured on #1104
 * (2026-08-07), a force-push re-anchored an existing review's `commit_id` to a
 * commit created after submission. The body's attestation is therefore the
 * record of which tree was examined; I3 remains fatal when it disagrees with
 * the current head.
 *
 * "Operative" excludes DISMISSED and PENDING: a dismissed review is disposed,
 * not a standing attestation.
 *
 * Do not replace this with the obvious shell one-liner that groups reviews by
 * commit_id and flags a group when its states differ. That formulation misses
 * two of the three invariants: identical duplicate verdicts (two APPROVEDs at
 * one head) have one unique state and slip through, and it has no notion of I3
 * at all. It also counts DISMISSED as a live divergent state, so it fires on
 * PRs that were correctly dispositioned. On the run that motivated this file it
 * found 1 instance where this script found 4.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// GitHub exposes this App as either its bot login or `app/<slug>` depending on
// the API surface. The bare `allyblockcast` login is the distinct User seat.
// A login alone is not review evidence: the REST review object must also carry
// the expected GitHub account type, so a lookalike/incorrectly typed identity
// cannot satisfy either protected-review lane.
const ALLY_APP_LOGIN_RE = /^(?:allyblockcast\[bot\]|app\/allyblockcast)$/;
const ALLY_APP_REVIEW_LOGIN_RE = /^allyblockcast\[bot\]$/;
const ALLY_SEAT_LOGIN_RE = /^allyblockcast$/;
const CANONICAL_REVIEW_HEADING_RE = /^## Ally — Consolidated PR Review[ \t]*$/gim;

/** A heading like `### Important Issues (2)` — but not `(0)`. */
const BLOCKING_SECTION_RE =
  /^#+[ \t]*(critical|important)[^\n]*\((?!0\))\d+\)/im;

/**
 * Leading whitespace that CommonMark would render as an indented code block,
 * i.e. quoted text rather than emitted structure. Four spaces reach column
 * four, and so does a tab however few spaces precede it.
 *
 * Must stay equivalent to NOT_INDENTED_CODE in
 * server/src/services/ally-review-detection.ts. BLO-31730 is a bug about two
 * parsers disagreeing on this exact line, so the auditor and the merge gate
 * must not disagree about which indentation counts.
 *
 * The two constants are deliberately not byte-identical, so compare the
 * *composed* forms rather than these lines. The module's is the bare pair of
 * lookaheads and each of its three use sites appends its own ` {0,3}`; this
 * one folds that quantifier in, because both of its use sites want it. What
 * must match is the composition — `(?! *\t)(?! {4}) {0,3}` on either side. A
 * future edit that reads this as a literal-identity claim and "restores" it
 * by deleting the ` {0,3}` here would silently stop allowing the up-to-three
 * spaces CommonMark still treats as a paragraph, which is the divergence this
 * comment exists to prevent.
 *
 * Residual, stated rather than implied: the gate additionally blanks fenced
 * spans before matching, and this script does not, so a *fenced* paste is
 * still read here as an attestation while the gate ignores it. The extra
 * attestation is not quietly absorbed — canonicalReviewHead requires exactly
 * one, so it returns null and the review is reported as an I3 "not canonical"
 * violation. (I3, not I1: I1 caps operative reviews per lane, not attestations
 * within a body.) The direction is still the safe one for an auditor, because
 * the consequence is a false red against an otherwise-valid review rather than
 * a missed one, but it is a real remaining divergence, not parity.
 */
const NOT_INDENTED_CODE = String.raw`(?! *\t)(?! {4}) {0,3}`;

/** A prior-finding disposition that says the blocker is still present. */
const STILL_PRESENT_DISPOSITION_RE = new RegExp(
  String.raw`^${NOT_INDENTED_CODE}-[ \t]*\*\*prior:[^\n]*\*\*[ \t]*(?:—|-)[ \t]*still-present[ \t]*(?:—|-)`,
  "im",
);

/** The single standalone attestation line Ally is required to emit. */
const ATTESTED_HEAD_RE = new RegExp(
  String.raw`^${NOT_INDENTED_CODE}(?:[_*]+)?[ \t]*reviewed head:[ \t]*\`?([0-9a-f]{40})\`?[ \t]*(?:[_*]+)?[ \t]*$`,
  "im",
);
const ATTESTED_HEAD_GLOBAL_RE = new RegExp(ATTESTED_HEAD_RE.source, "gim");

const ALLY_REVIEW_LANES = ["app", "seat"];

function normalizedLogin(login) {
  return String(login ?? "").trim().toLowerCase();
}

function normalizedAccountType(user) {
  return String(user?.type ?? "").trim().toLowerCase();
}

function laneLabel(lane) {
  return lane === "app" ? "Ally App" : "Ally User seat";
}

function reviewState(review) {
  return String(review?.state ?? "UNKNOWN").toUpperCase();
}

function isDismissedOrPending(review) {
  const state = reviewState(review);
  return state === "DISMISSED" || state === "PENDING";
}

function isApproved(review) {
  return reviewState(review) === "APPROVED";
}

function hasBlockingVerdict(body) {
  return hasBlockingFindings(body) || hasStillPresentDisposition(body);
}

function reviewDetails(reviews) {
  return reviews.map((review) => `${reviewState(review)}/${review.id}`).join(", ");
}

export function canonicalReviewHead(body) {
  const text = String(body ?? "");
  const headings = Array.from(text.matchAll(CANONICAL_REVIEW_HEADING_RE));
  const attestations = Array.from(text.matchAll(ATTESTED_HEAD_GLOBAL_RE));
  if (headings.length !== 1 || attestations.length !== 1) return null;
  return attestations[0][1].toLowerCase();
}

// The two GitHub principals the guard must recognise. Recognising both is not
// endorsing both: only the App may carry a verdict, and every operative seat
// review is a violation (I6, R4/BLO-24056). Do not read this pair as a shape
// something requires.
//
// Only the IDs have production consumers — `allyReviewIdentityShape` pins the
// immutable REST ID per lane, so an impostor matching a login regex is caught
// by I5 rather than silently accepted. The login constants are retained as the
// canonical spelling and for the test fixtures that exercise that mismatch.
export const ALLY_APP_REVIEWER_ID = 290875700;
export const ALLY_APP_REVIEWER_LOGIN = "allyblockcast[bot]";
export const ALLY_USER_REVIEWER_ID = 296676656;
export const ALLY_USER_REVIEWER_LOGIN = "allyblockcast";

export function isAllyLogin(login) {
  return isAllySeatLogin(login) || isAllyAppLogin(login);
}

export function isAllyAppLogin(login) {
  return ALLY_APP_LOGIN_RE.test(normalizedLogin(login));
}

export function isAllySeatLogin(login) {
  return ALLY_SEAT_LOGIN_RE.test(normalizedLogin(login));
}

function allyReviewIdentityShape(user) {
  if (
    ALLY_APP_REVIEW_LOGIN_RE.test(normalizedLogin(user?.login)) &&
    normalizedAccountType(user) === "bot"
  ) {
    return { lane: "app", expectedId: ALLY_APP_REVIEWER_ID };
  }
  if (
    ALLY_SEAT_LOGIN_RE.test(normalizedLogin(user?.login)) &&
    normalizedAccountType(user) === "user"
  ) {
    return { lane: "seat", expectedId: ALLY_USER_REVIEWER_ID };
  }
  return null;
}

export function isAllyAppReviewer(user) {
  const identity = allyReviewIdentityShape(user);
  return identity?.lane === "app" && user?.id === identity.expectedId;
}

export function isAllySeatReviewer(user) {
  const identity = allyReviewIdentityShape(user);
  return identity?.lane === "seat" && user?.id === identity.expectedId;
}

export function allyReviewLane(user) {
  if (isAllySeatReviewer(user)) return "seat";
  if (isAllyAppReviewer(user)) return "app";
  return null;
}

export function hasBlockingFindings(body) {
  return BLOCKING_SECTION_RE.test(String(body ?? ""));
}

export function hasStillPresentDisposition(body) {
  return STILL_PRESENT_DISPOSITION_RE.test(String(body ?? ""));
}

export function attestedHead(body) {
  const match = ATTESTED_HEAD_RE.exec(String(body ?? ""));
  return match ? match[1].toLowerCase() : null;
}

export function operativeAllyReviews(reviews, headSha, lane = null) {
  const normalizedHead = String(headSha ?? "").toLowerCase();
  return (reviews ?? []).filter(
    (review) => {
      const reviewLane = allyReviewLane(review?.user);
      return (
        reviewLane !== null &&
        (lane === null || reviewLane === lane) &&
        !isDismissedOrPending(review) &&
        String(review?.commit_id ?? "").toLowerCase() === normalizedHead
      );
    },
  );
}

function isCleanAppSelfReview(pr, review) {
  return (
    isAllyAppLogin(pr?.author?.login) &&
    pr?.author?.is_bot === true &&
    reviewState(review) === "COMMENTED" &&
    !hasBlockingVerdict(review.body)
  );
}

/**
 * A review body reduced to the form the equality rules below compare.
 *
 * Trimming is deliberately the only normalization. Passing one body file to
 * both review calls produces byte-identical bodies, but a stray trailing
 * newline is still one verdict posted twice. Two bodies that differ in
 * substance remain two independent write-ups.
 *
 * This helper is used by both the same-lane relation and the cross-credential
 * duplicate diagnostic. Keeping the normalization at both decision points stops
 * one of them exempting a body shape the other would have flagged.
 */
export function normalizedBody(review) {
  return String(review?.body ?? "").trim();
}

/**
 * True when two operative reviews carry the same substantive body under
 * different identities. Empty bodies are excluded because that is an
 * attestation defect, not evidence of one verdict submitted twice.
 */
export function duplicateBodyAcrossIdentities(operative) {
  const reviews = operative ?? [];
  const bodies = reviews.map(normalizedBody);
  return reviews.some((a, i) =>
    reviews.some(
      (b, j) =>
        j > i && bodies[i] !== "" && bodies[i] === bodies[j] && a?.user?.id !== b?.user?.id,
    ),
  );
}

/**
 * Classifies a same-lane duplicate by comparing the bodies against each other.
 *
 * I1 says two reviews in one lane is a violation; it does not say which defect
 * produced them, and the two need different fixes. The bodies discriminate:
 *
 *   "resubmit"  Every body is identical. One computed verdict reached GitHub
 *               more than once, so the submit step is at-least-once. Ally holds
 *               the composed body in context, so a retried submit re-sends the
 *               same bytes; two independent runs cannot emit identical prose.
 *   "recompute" The bodies differ. Two full reviews were computed for one head
 *               and both were submitted, so the missing control is exclusion
 *               (one reviewer per head), not submit idempotency.
 *   "mixed"     Both shapes at once: >2 reviews, some identical, some distinct.
 *   null        Not a duplicate, or a body is empty — an empty body is an
 *               attestation defect (I3), and guessing a mode from it would
 *               assert a mechanism the evidence does not carry.
 *
 * Timing is NOT a substitute for this. PEN-2865 first split these modes by the
 * gap between submissions on the theory that seconds meant a retry and hours
 * meant a re-review. Measured on paperclip#1220, two reviews 10 s apart carried
 * different bodies (8513 vs 6564 bytes) — a genuine double-compute inside the
 * window the timing rule reserved for retries. Reporting the gap alone had
 * already produced one wrong recommendation, which is why the classification
 * lives here rather than in the reader's head.
 *
 * Keep the label free of any 6-digit-or-longer number. `violationFingerprint`
 * harvests every such token out of the message text, so a count or an account
 * id embedded here would change the fingerprint of an I1 finding and silently
 * void the matching baseline suppression.
 */
export function sameLaneBodyRelation(operative) {
  const reviews = operative ?? [];
  if (reviews.length < 2) return null;
  const bodies = reviews.map(normalizedBody);
  if (bodies.some((body) => body === "")) return null;
  const identical = bodies.every((body) => body === bodies[0]);
  if (identical) return "resubmit";
  const anyPairIdentical = bodies.some((body, i) =>
    bodies.some((other, j) => j > i && body === other),
  );
  return anyPairIdentical ? "mixed" : "recompute";
}

const SAME_LANE_RELATION_NOTES = {
  resubmit:
    "the bodies are identical — one verdict submitted more than once, so the submit step is at-least-once",
  recompute:
    "the bodies differ — two reviews were computed for this one head and both submitted, so the missing control is exclusion, not submit idempotency",
  mixed:
    "some bodies are identical and some differ — both a repeated submit and an independent recomputation are present",
};

/**
 * @param {{number: number, headSha: string, author?: {login?: string, is_bot?: boolean}, reviews: object[]}} pr
 * @returns {string[]} human-readable violations; empty when the PR is sound
 */
export function findPrViolations(pr) {
  const head = pr.headSha;
  const short = String(head ?? "").slice(0, 8);
  const violations = [];

  for (const review of pr.reviews ?? []) {
    if (isDismissedOrPending(review) || String(review?.commit_id ?? "").toLowerCase() !== String(head ?? "").toLowerCase()) {
      continue;
    }
    const identity = allyReviewIdentityShape(review?.user);
    if (identity && review?.user?.id !== identity.expectedId) {
      violations.push(
        `I5 PR #${pr.number} @${short}: ${laneLabel(identity.lane)} review ${review.id} uses the canonical login/type but REST id ${String(review?.user?.id ?? "<missing>")} (expected ${identity.expectedId}) — identity mismatch cannot satisfy the review lane`,
      );
    }
  }

  const reviewsByLane = new Map(
    ALLY_REVIEW_LANES.map((lane) => [lane, operativeAllyReviews(pr.reviews, head, lane)]),
  );

  for (const lane of ALLY_REVIEW_LANES) {
    const reviews = reviewsByLane.get(lane);
    const label = laneLabel(lane);

    if (reviews.length > 1) {
      const relation = SAME_LANE_RELATION_NOTES[sameLaneBodyRelation(reviews)];
      violations.push(
        `I1 PR #${pr.number} @${short}: ${reviews.length} operative ${label} reviews (${reviewDetails(reviews)}) — expected at most 1 in the ${lane} lane` +
          (relation ? `; ${relation}` : ""),
      );
    }

    for (const review of reviews) {
      const blocking = hasBlockingVerdict(review.body);

      // R4 (BLO-24056, ratified by the CEO ruling on BLO-29559): the User seat
      // shares a login with the authoring App, so a seat verdict is the same
      // head both writing a change and clearing it. It never submits a review,
      // an approval, or a REQUEST_CHANGES under any condition. Its only
      // sanctioned operation is dismissing a stale approval, and a DISMISSED
      // review is already excluded from the operative set above.
      //
      // This subsumes BLO-22916 Defect 2: the five content-free approvals that
      // carried no `Reviewed head:` line were all seat submissions, and the
      // App-only I2d check below could never see them.
      //
      // The `continue` skips I2a/I2c for this review. Detection is unchanged
      // and remains a strict superset — I6 is unconditional over the lane, so
      // a seat APPROVED carrying a Critical finding is still a violation; only
      // the diagnostic narrows, from "approved over a blocker" to "the seat
      // may not submit at all". I2b still reports the blocker-masking case.
      if (lane === "seat") {
        violations.push(
          `I6 PR #${pr.number} @${short}: ${label} review ${review.id} is ${reviewState(review)} — the User seat (uid ${ALLY_USER_REVIEWER_ID}) never submits a verdict (R4, BLO-24056); only the App (uid ${ALLY_APP_REVIEWER_ID}) may carry one`,
        );
        continue;
      }

      if (lane === "app") {
        const canonicalHead = canonicalReviewHead(review.body);
        const attested = attestedHead(review.body);
        if (!canonicalHead) {
          violations.push(
            `I3 PR #${pr.number} @${short}: ${label} review ${review.id} is not canonical — expected one consolidated-review heading and one Reviewed head attestation`,
          );
        }

        if (attested && attested !== String(head ?? "").toLowerCase()) {
          violations.push(
            `I3 PR #${pr.number} @${short}: ${label} review ${review.id} attests head ${attested.slice(0, 8)} but is now recorded against ${short} — a force-push re-anchored it, so it stands as an attestation of a tree its author never read`,
          );
        }

        if (isApproved(review) && attested === null) {
          violations.push(
            `I2d PR #${pr.number} @${short}: ${label} review ${review.id} is APPROVED but its body makes no "Reviewed head:" attestation — an approval with no review behind it`,
          );
        }
      }

      if (!isApproved(review) && !blocking && !isCleanAppSelfReview(pr, review)) {
        violations.push(
          `I4 PR #${pr.number} @${short}: ${label} review ${review.id} is ${reviewState(review)} but clean App evidence must be APPROVED`,
        );
      }

      if (isApproved(review) && hasBlockingFindings(review.body)) {
        violations.push(
          `I2a PR #${pr.number} @${short}: ${label} review ${review.id} is APPROVED but its body reports a Critical/Important finding`,
        );
      }
      if (isApproved(review) && hasStillPresentDisposition(review.body)) {
        violations.push(
          `I2c PR #${pr.number} @${short}: ${label} review ${review.id} is APPROVED but its body marks a prior finding still-present`,
        );
      }
    }
  }

  const appReviews = reviewsByLane.get("app");
  const seatReviews = reviewsByLane.get("seat");
  if (
    appReviews.length === 1 &&
    seatReviews.length === 1 &&
    duplicateBodyAcrossIdentities([...appReviews, ...seatReviews])
  ) {
    const detail = [...appReviews, ...seatReviews]
      .map((review) => `${reviewState(review)}/${review.id}`)
      .join(", ");
    violations.push(
      `I1 PR #${pr.number} @${short}: 2 operative Ally reviews (${detail}) — the same body submitted under two credentials — one verdict, posted twice (BLO-22916)`,
    );
  }
  const seatApprovals = reviewsByLane.get("seat").filter(isApproved);
  const appBlockers = appReviews.filter((review) => hasBlockingVerdict(review.body));
  if (seatApprovals.length > 0 && appBlockers.length > 0) {
    violations.push(
      `I2b PR #${pr.number} @${short}: User-seat APPROVED (${seatApprovals.map((review) => review.id).join(", ")}) coexists with a blocking Ally App review (${appBlockers.map((review) => review.id).join(", ")}) — the User seat cannot mask the App blocker`,
    );
  }
  return violations;
}

export function findViolations(prs) {
  return (prs ?? []).flatMap((pr) => findPrViolations(pr));
}

/**
 * The ratchet.
 *
 * This guard audits every open PR forever, so a single abandoned PR carrying a
 * duplicate Ally review holds the run red permanently. Measured over the 40
 * scheduled runs before 2026-09-01: 39 failures, 1 success, with a byte-identical
 * six-violation set on every failing run, pinned by four PRs last touched between
 * 1 and 20 days earlier. A check whose output is a constant carries the same
 * information as no check: a seventh violation appearing on a live PR would move
 * the run from red to red and change nothing downstream. The invariants were still
 * computed correctly the whole time — what was lost was the ability to *signal*.
 * See PEN-2847.
 *
 * So known violations are recorded in a baseline and suppressed, and anything not
 * in the baseline fails the run. The load-bearing detail is what a baseline entry
 * is keyed on: the fingerprint pins the invariant code, the PR number, the head
 * SHA, *and* the exact set of review IDs named in the violation. That makes an
 * entry expire on its own the moment anything real changes —
 *
 *   - the PR is pushed to     → new head → no entry matches → red
 *   - a third review lands    → new ID set → no entry matches → red
 *   - a different invariant   → new code → no entry matches → red
 *   - any other PR regresses  → never baselined → red
 *
 * — which is a sharper liveness test than the obvious alternative of scoping the
 * audit to PRs updated within N days. That alternative was measured against this
 * repo before it was rejected: #1525 sits at `mergeable_state: behind`, inside any
 * plausible allow-list, and was updated 2 days before filing, inside any plausible
 * window. It would have stayed in scope and the run would have stayed red. A PR
 * that could actually merge on a bad attestation is one that is *moving*, and a
 * moving PR breaks its own baseline entry. Staleness is a proxy for that; the head
 * SHA measures it directly.
 *
 * That rejection stands, and `prDormancy` below does **not** reverse it — there is
 * still no calendar window here. What the ratchet alone does not cover is a PR that
 * carries a real violation and *cannot merge at all*, which the ratchet can only
 * dispose of by having a human write a baseline entry for every one of them. As of
 * 2026-09-20 exactly one unbaselined violation was outstanding repo-wide (#1220
 * @a9ee094a) and it is `DIRTY`; all six original baseline entries had self-expired.
 * So the run was red, un-actionably, over a PR GitHub itself refuses to merge.
 *
 * The two legs of "liveness" are not equally safe and only one is adopted:
 *
 *   - **Cannot-merge (adopted).** `DIRTY` and `draft` are states GitHub enforces at
 *     the merge button. Leaving one is a state transition this guard re-observes on
 *     its next hourly run, so deferring is bounded: the PR cannot reach `master`
 *     without first re-entering scope. For `DIRTY` the exposure is usually nil —
 *     resolving conflicts means pushing, which moves the head, which sheds the
 *     violation outright.
 *   - **Not-updated-in-N-days (still rejected).** Staleness is not a state GitHub
 *     enforces anything against. A `CLEAN` PR untouched for 30 days merges on a
 *     click, with no push, no transition, and no run in between — the guard never
 *     gets its chance to red. That is unbounded fail-open on exactly the BLO-19778
 *     incident, and it is why #1525's two-day-old `BEHIND` measurement killed the
 *     window approach and still does.
 *
 * Measured on the 121 open PRs of 2026-09-20: 71 live, 50 dormant. #1316
 * (`UNSTABLE`) and #1360 (`BEHIND`) — two of the four PRs that originally pinned
 * this guard — classify **live**, so this scoping grants them no amnesty; their
 * findings expired by head movement, as designed.
 *
 * A baseline entry is a suppression of a real finding, so each one must name the
 * PR and the issue that owns its disposition, and a malformed entry throws rather
 * than being skipped — a baseline that silently ignores its own bad rows is the
 * fail-open shape `assertPrListComplete` and `assertHeadSha` already guard against
 * one layer up.
 */
export const BASELINE_PATH = "scripts/ally-review-consistency-baseline.json";

/**
 * A violation reduced to the tokens that identify *which* violation it is,
 * discarding the prose.
 *
 * Every push site in `findPrViolations` emits the same structured prefix —
 * `${code} PR #${number} @${shortHead}: ` — and names the review IDs it is
 * complaining about in the tail. Those four things are the finding's identity;
 * the explanatory sentence after them is not, and rewording a message must not
 * silently move a violation out from under its baseline entry.
 *
 * Review IDs are 9-10 digits and PR numbers are 4, so the digit-run floor
 * separates them without needing to parse each message shape individually. The
 * floor is not exclusive to review IDs: I6 embeds both reviewer uids, which are
 * 9 digits and so join the scraped set. That is harmless — both uids are
 * constant across every I6, so they cannot merge two distinct findings, and the
 * real review ID is still in the set, so the expiry properties hold. If a
 * future message shape defeats this scraping the fingerprint changes and the run
 * goes red — the safe direction.
 */
export function violationFingerprint(violation) {
  const text = String(violation ?? "");
  const code = /^(\S+)\s/.exec(text)?.[1] ?? "?";
  const pr = /\bPR #(\d+)\b/.exec(text)?.[1] ?? "?";
  const head = /\B@([0-9a-f]{6,40})\b/.exec(text)?.[1]?.toLowerCase() ?? "?";
  const ids = [...new Set(Array.from(text.matchAll(/\b\d{6,}\b/g), (m) => m[0]))].sort();
  return `${code}:${pr}:${head}:${ids.join(",")}`;
}

/**
 * Validates the baseline document and returns its entries.
 *
 * Throws on anything malformed. An entry that cannot be understood is a
 * suppression nobody can audit, and silently dropping it would let a typo'd
 * fingerprint read as "this violation is known" when nothing is known at all.
 */
export function parseBaseline(raw, path = BASELINE_PATH) {
  let doc;
  try {
    doc = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`);
  }
  const entries = doc?.entries;
  if (!Array.isArray(entries)) {
    throw new Error(`${path} must contain an "entries" array (got ${JSON.stringify(doc?.entries)}).`);
  }

  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    const where = `${path} entries[${index}]`;
    for (const field of ["fingerprint", "note", "issue"]) {
      if (typeof entry?.[field] !== "string" || entry[field].trim() === "") {
        throw new Error(`${where} needs a non-empty "${field}" — every suppression must be attributable.`);
      }
    }
    if (!Number.isInteger(entry.pr)) {
      throw new Error(`${where} needs an integer "pr" (got ${JSON.stringify(entry?.pr)}).`);
    }
    if (!/^[A-Za-z0-9]+:\d+:[0-9a-f]{6,40}:[\d,]*$/.test(entry.fingerprint)) {
      throw new Error(
        `${where} has a malformed "fingerprint" (${JSON.stringify(entry.fingerprint)}); ` +
          `expected code:pr:head:ids as produced by violationFingerprint().`,
      );
    }
    if (String(entry.fingerprint.split(":")[1]) !== String(entry.pr)) {
      throw new Error(
        `${where} fingerprint names PR #${entry.fingerprint.split(":")[1]} but "pr" says ${entry.pr}.`,
      );
    }
    if (seen.has(entry.fingerprint)) {
      throw new Error(`${where} repeats fingerprint ${entry.fingerprint}.`);
    }
    seen.add(entry.fingerprint);
  }
  return entries;
}

/**
 * Splits live violations into the ones that fail the run and the ones a baseline
 * entry accounts for, and reports entries that matched nothing.
 *
 * A stale entry is deliberately *not* fatal. Baselined PRs get merged, closed and
 * force-pushed as a matter of course, and making that turn the run red would
 * reintroduce exactly the permanently-red failure this ratchet exists to cure —
 * this time triggered by the guard's own bookkeeping. It is reported so the entry
 * can be pruned, and pruning it is a no-op for the verdict.
 */
export function applyBaseline(violations, entries) {
  const byFingerprint = new Map((entries ?? []).map((entry) => [entry.fingerprint, entry]));
  const matched = new Set();
  const failing = [];
  const suppressed = [];

  for (const violation of violations ?? []) {
    const fingerprint = violationFingerprint(violation);
    const entry = byFingerprint.get(fingerprint);
    if (entry) {
      matched.add(fingerprint);
      suppressed.push({ violation, entry });
    } else {
      failing.push({ violation, fingerprint });
    }
  }

  return {
    failing,
    suppressed,
    staleEntries: (entries ?? []).filter((entry) => !matched.has(entry.fingerprint)),
  };
}

/**
 * The merge states GitHub will not merge from, so a violation under one of them
 * cannot reach `master` without the PR first changing state.
 *
 * Deliberately a deny-list of two, not an allow-list of the mergeable states.
 * `mergeStateStatus` is lazily computed server-side and reports `UNKNOWN` until
 * GitHub finishes — 5 of 121 open PRs were `UNKNOWN` when this was written — and
 * GitHub adds values to this enum without notice. An allow-list would silently
 * drop every unrecognised and every not-yet-computed state out of the audit, which
 * is the fail-open shape this whole file exists to prevent. Anything not named
 * here is treated as live and can fail the run.
 */
export const DORMANT_MERGE_STATES = new Set(["DIRTY"]);

/**
 * Why a PR cannot merge right now, or `null` if it can.
 *
 * Unknown, missing and malformed inputs all resolve to `null` (live) on purpose:
 * the only thing that defers a finding is positive evidence that GitHub is
 * blocking the merge. Absence of evidence keeps the finding fatal.
 */
export function prDormancy(pr) {
  if (pr?.isDraft === true) {
    return "draft";
  }
  const state = String(pr?.mergeStateStatus ?? "").toUpperCase();
  if (DORMANT_MERGE_STATES.has(state)) {
    return `merge state ${state}`;
  }
  return null;
}

/**
 * Refuses to run an audit that has scoped itself down to nothing.
 *
 * Deferring findings on unmergeable PRs is only sound while the live set is a
 * real population. If a `mergeStateStatus` schema change, a token losing a field,
 * or a bad edit here ever classified every PR dormant, every violation would
 * downgrade to a warning and the run would print a green pass having failed
 * nothing — "green because it stopped checking", which PEN-2847 names as worse
 * than the permanent red it replaced. Same reflex as `assertPrListComplete` and
 * `assertHeadSha`: throw rather than assert nothing.
 */
export function assertLiveScopeNonVacuous(prs, repo) {
  const rows = prs ?? [];
  if (rows.length > 0 && rows.every((pr) => prDormancy(pr) !== null)) {
    throw new Error(
      `every one of the ${rows.length} open PR(s) in ${repo} classified as unmergeable, ` +
        `so no finding could fail this run. That is a scoping bug, not a clean repo: ` +
        `check that gh pr list still returns isDraft/mergeStateStatus.`,
    );
  }
  return rows;
}

/**
 * Splits unbaselined findings into the ones that can still reach `master` and the
 * ones GitHub is currently refusing to merge.
 *
 * A finding is matched to its PR by the number already parsed into its
 * fingerprint. A finding whose PR cannot be resolved — unparseable number, or a PR
 * absent from the fetched set — stays in `failing`, because "I could not tell
 * whether this one matters" must not read as "this one does not matter".
 */
export function partitionByMergeEligibility(failing, prs) {
  const byNumber = new Map((prs ?? []).map((pr) => [String(pr?.number), pr]));
  const live = [];
  const deferred = [];

  for (const item of failing ?? []) {
    const number = String(item?.fingerprint ?? "").split(":")[1];
    const pr = byNumber.get(number);
    const reason = pr ? prDormancy(pr) : null;
    if (reason) {
      deferred.push({ ...item, reason });
    } else {
      live.push(item);
    }
  }

  return { failing: live, deferred };
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * `gh pr list` caps at whatever `--limit` we pass and truncates silently. A
 * truncated list would let the guard print a pass over PRs it never fetched —
 * the same fail-open shape this script exists to catch — so hitting the cap is
 * a hard error, not a warning.
 */
const PR_LIST_LIMIT = 500;

export function assertPrListComplete(rows, repo, limit = PR_LIST_LIMIT) {
  if ((rows ?? []).length >= limit) {
    throw new Error(
      `gh pr list returned ${rows.length} open PR(s) for ${repo}, at the --limit of ` +
        `${limit}: the list is probably truncated and this guard cannot assert ` +
        `its invariant over PRs it never fetched. Raise PR_LIST_LIMIT.`,
    );
  }
  return rows;
}

/**
 * Every invariant here pivots on `headSha`: `operativeAllyReviews` filters
 * `commit_id === headSha`, so a falsy or malformed head matches no review, the
 * operative set is empty, and I1/I2/I3 all iterate nothing. The run then prints
 * a pass having asserted nothing across every PR at once — the same fail-open
 * shape as an unreachable `main()`, one layer up. Verified: with `headSha` set
 * to `undefined`, `null` or `""`, a deliberately maximal violation (an APPROVED
 * reporting `### Critical Issues (3)`, attesting a different SHA, coexisting
 * with a blocking COMMENTED) yields zero violations. Assert it for the same
 * reason `assertPrListComplete` throws rather than warns.
 */
export function assertHeadSha(row, repo) {
  if (!/^[0-9a-f]{40}$/.test(String(row?.headRefOid ?? ""))) {
    throw new Error(
      `gh pr list returned no usable headRefOid for ${repo}#${row?.number} ` +
        `(got ${JSON.stringify(row?.headRefOid)}). Every invariant in this guard ` +
        `filters reviews on commit_id === head, so continuing would assert ` +
        `nothing while reporting a pass.`,
    );
  }
  return row;
}

function fetchOpenPrs(repo) {
  // number + headRefOid both come back from this one call; fetching the head
  // via `gh api repos/{repo}/pulls/{number}` instead would pull a ~22 KB
  // payload per PR to read one field.
  const rows = JSON.parse(
    gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      String(PR_LIST_LIMIT),
      "--json",
      "number,headRefOid,author,isDraft,mergeStateStatus",
    ]),
  );

  assertPrListComplete(rows, repo);

  return rows.map((row) => ({
    number: assertHeadSha(row, repo).number,
    headSha: row.headRefOid,
    author: row.author,
    isDraft: row.isDraft,
    mergeStateStatus: row.mergeStateStatus,
    reviews: JSON.parse(
      gh(["api", `repos/${repo}/pulls/${row.number}/reviews`, "--paginate"]),
    ),
  }));
}

function loadBaseline() {
  const path = resolve(fileURLToPath(new URL(".", import.meta.url)), "ally-review-consistency-baseline.json");
  return parseBaseline(readFileSync(path, "utf8"), BASELINE_PATH);
}

function main() {
  const repo = process.env.ALLY_REVIEW_REPO || "Blockcast/paperclip";
  const prs = fetchOpenPrs(repo);
  assertLiveScopeNonVacuous(prs, repo);
  const violations = findViolations(prs);
  const baselined = applyBaseline(violations, loadBaseline());
  const { suppressed, staleEntries } = baselined;
  const { failing, deferred } = partitionByMergeEligibility(baselined.failing, prs);
  const liveCount = prs.filter((pr) => prDormancy(pr) === null).length;

  for (const entry of staleEntries) {
    console.log(
      `::warning title=Stale ally-review-consistency baseline entry::` +
        `${BASELINE_PATH} still suppresses ${entry.fingerprint} (PR #${entry.pr}, ${entry.issue}) but no ` +
        `current violation matches it — the finding is resolved or the PR moved. Remove the entry.`,
    );
  }

  if (suppressed.length > 0) {
    console.log(`Suppressed by ${BASELINE_PATH} (${suppressed.length} known violation(s)):\n`);
    for (const { violation, entry } of suppressed) {
      console.log(`  [${entry.issue}] ${violation}`);
    }
    console.log("");
  }

  if (deferred.length > 0) {
    console.log(
      `Deferred (${deferred.length}) — real, unbaselined findings on PR(s) GitHub will not ` +
        `merge from. Each returns to failing the moment its PR becomes mergeable:\n`,
    );
    for (const { violation, fingerprint, reason } of deferred) {
      console.log(
        `::warning title=Ally review-consistency finding on an unmergeable PR::` +
          `${violation} [${reason}]`,
      );
      console.log(`    fingerprint: ${fingerprint}`);
    }
    console.log("");
  }

  if (failing.length > 0) {
    console.error(
      `Ally review-consistency guard FAILED for ${repo} (${failing.length} unbaselined violation(s) on mergeable PR(s)):\n`,
    );
    for (const { violation, fingerprint } of failing) {
      console.error(`  ${violation}`);
      console.error(`    fingerprint: ${fingerprint}`);
    }
    console.error(
      "\nA violation means a PR may present as reviewed or approved without a single " +
        "operative attestation backing its current head. See BLO-19778.\n" +
        `Fix the PR, or — only if the finding is genuinely accepted — add its fingerprint to ` +
        `${BASELINE_PATH} with the PR number, the owning issue, and a note. A baseline entry is ` +
        `pinned to the head SHA and review IDs above, so it expires the moment the PR is touched.`,
    );
    process.exit(1);
  }

  console.log(
    `Ally review-consistency guard passed: no unbaselined attestation conflicts found across ` +
      `${liveCount} mergeable PR(s) of ${prs.length} open in ${repo}` +
      `${deferred.length > 0 ? `, ${deferred.length} finding(s) deferred on unmergeable PRs` : ""}.`,
  );
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule()) {
  main();
}
