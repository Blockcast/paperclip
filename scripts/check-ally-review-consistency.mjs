#!/usr/bin/env node

/**
 * Guards the integrity of Ally's GitHub review attestations.
 *
 * Ally composes a consolidated review body and posts it with `gh pr review`.
 * Nothing server-side enforces one verdict per head, and several independent
 * wake sources (marker comment, ready_for_review toggle, and review-request
 * issue assignment) can each launch a run for the same PR. Concurrent runs
 * therefore race, and the races are not benign: a clean run approves as the
 * `allyblockcast` USER (write access, counts toward `reviewDecision`) while a
 * finding-bearing run comments as the `[bot]` App (does not count), so a green
 * approval can outrank and mask an open blocker at the same SHA.
 *
 * Observed on Blockcast/paperclip#876 (BLO-19778): two runs dispatched 43 ms
 * apart both submitted at head ff1c72db, 34 s apart, with opposite verdicts.
 *
 * Invariants asserted here:
 *   I1  At most one operative Ally review submission per (PR, head SHA), or
 *       exactly the current-head APPROVED App/User pair mandated by protected
 *       merge. Every other multi-review shape is fatal. The pair is checked as
 *       two independent, exact identities—not by removing or normalizing a
 *       review—so retries and lookalike credentials remain visible.
 *   I2  No operative Ally APPROVED whose own body reports a Critical or
 *       Important finding, no operative APPROVED coexisting at a SHA with an
 *       operative Ally review that does, and no operative APPROVED that makes
 *       no `Reviewed head:` attestation at all.
 *   I3  An operative Ally review's body-attested `Reviewed head:` matches the
 *       commit GitHub recorded it against, so a standing approval is not
 *       presented against a tree its author never read.
 *
 * On I3's mechanism. An earlier revision of this file said `gh pr review`
 * binds a review to the head at submit time, so a mid-review push "certifies a
 * tree that was never read". Submit-time binding is real but it is not what
 * produces most I3 hits, and the difference matters because the old wording
 * blamed the reviewer for a value the reviewer never set. Measured on #1104
 * (2026-08-07): review 4878131987 was submitted at 20:52:00Z attesting
 * 2533dc6f, the timeline records `head_ref_force_pushed cee75d97` at 21:07:07Z
 * creating a commit dated 21:06:55Z, and the review's `commit_id` now reads
 * cee75d97 — a commit that did not exist when it was submitted. A review
 * cannot be bound at submit time to a commit created 15 minutes later, so a
 * force-push re-anchors existing reviews forward onto the new head. Same shape
 * on #1098 (+28m), #1111 (+5m), #1067 (+10h23m). `commit_id` is therefore not
 * a record of which tree a review examined; the body's attestation line is.
 * I3 stays fatal because the hazard is real either way — a green is being
 * presented at a head nobody read — but the remedy is to dismiss or re-review
 * the stale approval, not to correct the reviewer.
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
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ALLY_LOGIN_RE =
  /^(allyblockcast|blockcast-ally|ally-bot|blockcast-ci-packages)(\[bot\])?$/;

/** A heading like `### Important Issues (2)` — but not `(0)`. */
const BLOCKING_SECTION_RE =
  /^#+[ \t]*(critical|important)[^\n]*\((?!0\))\d+\)/im;

/** A prior-finding disposition that says the blocker is still present. */
const STILL_PRESENT_DISPOSITION_RE =
  /^[ \t]*-[ \t]*\*\*prior:[^\n]*\*\*[ \t]*(?:—|-)[ \t]*still-present[ \t]*(?:—|-)/im;

/** The single standalone attestation line Ally is required to emit. */
const ATTESTED_HEAD_RE = /^[ \t]*(?:[_*]+)?[ \t]*reviewed head:[ \t]*`?([0-9a-f]{40})`?[ \t]*(?:[_*]+)?[ \t]*$/im;

// The two distinct GitHub principals required by the protected-merge policy.
// Pin both the immutable REST ID and the canonical login: either mismatch is
// not an eligible substitute for the required artifact.
export const ALLY_APP_REVIEWER_ID = 290875700;
export const ALLY_APP_REVIEWER_LOGIN = "allyblockcast[bot]";
export const ALLY_USER_REVIEWER_ID = 296676656;
export const ALLY_USER_REVIEWER_LOGIN = "allyblockcast";

export function isAllyLogin(login) {
  return ALLY_LOGIN_RE.test(String(login ?? ""));
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

export function operativeAllyReviews(reviews, headSha) {
  return (reviews ?? []).filter(
    (review) =>
      isAllyLogin(review?.user?.login) &&
      review?.state !== "DISMISSED" &&
      review?.state !== "PENDING" &&
      review?.commit_id === headSha,
  );
}

function isExpectedApproval(review, { id, login }, headSha) {
  return (
    review?.state === "APPROVED" &&
    review?.user?.id === id &&
    review?.user?.login === login &&
    attestedHead(review?.body) === String(headSha ?? "").toLowerCase()
  );
}

/**
 * The only permitted two-review shape: one current-head approval from the
 * required App identity and one from the required User seat. This deliberately
 * inspects the full operative set instead of deduplicating it; a retry, an
 * unexpected identity, or a missing/stale attestation makes the shape fail.
 *
 * The two bodies must also differ. This exemption exists for the case where a
 * gate genuinely needs both seats — an App-authored PR, or a CODEOWNERS/team
 * approver a GitHub App cannot be — and there the User seat contributes a
 * short, distinct approval linking to the App's review. Two *byte-identical*
 * bodies are not that case: they are one verdict submitted twice under two
 * credentials, which is BLO-22916's defect and the mechanism that held this
 * guard red from 2026-08-02 to 2026-08-16. Ally's instructions now forbid
 * passing the same `--body-file` to both calls; this is where that is enforced,
 * so a future run cannot re-derive "submit under both to be safe" and have the
 * audit call it sound.
 */
export function isRequiredApprovalPair(reviews, headSha) {
  const operative = operativeAllyReviews(reviews, headSha);
  if (operative.length !== 2) return false;
  if (operative[0].body === operative[1].body) return false;

  return (
    operative.some((review) =>
      isExpectedApproval(
        review,
        { id: ALLY_APP_REVIEWER_ID, login: ALLY_APP_REVIEWER_LOGIN },
        headSha,
      ),
    ) &&
    operative.some((review) =>
      isExpectedApproval(
        review,
        { id: ALLY_USER_REVIEWER_ID, login: ALLY_USER_REVIEWER_LOGIN },
        headSha,
      ),
    )
  );
}

/**
 * True when two operative reviews carry byte-identical bodies under different
 * user IDs — AC1's literal wording in BLO-22916, and the fingerprint of one
 * run submitting its verdict twice rather than two independent passes (two
 * passes produce two different write-ups).
 *
 * An empty body is excluded. Two bodiless approvals under two seats compare
 * equal, but they are not one verdict posted twice — there is no verdict at
 * all. That is Defect 2 (a counting APPROVED with no review behind it), I2d
 * already reports it, and its remedy is to post a comment rather than to drop
 * one of the two submissions.
 *
 * @param {object[]} operative reviews ALREADY filtered to the operative set for
 *   one head, as returned by {@link operativeAllyReviews}. Passing a raw
 *   `pr.reviews` list would compare dismissed and stale-head reviews and so
 *   answer a different question than the caller intends.
 * @returns {boolean} true when the duplicate-submission shape is present
 */
export function duplicateBodyAcrossIdentities(operative) {
  const reviews = operative ?? [];
  return reviews.some((a, i) =>
    reviews.some(
      (b, j) =>
        j > i && Boolean(a?.body) && a?.body === b?.body && a?.user?.id !== b?.user?.id,
    ),
  );
}

/**
 * @param {{number: number, headSha: string, reviews: object[]}} pr
 * @returns {string[]} human-readable violations; empty when the PR is sound
 */
export function findPrViolations(pr) {
  const head = pr.headSha;
  const short = String(head ?? "").slice(0, 8);
  const operative = operativeAllyReviews(pr.reviews, head);
  const violations = [];

  if (operative.length > 1 && !isRequiredApprovalPair(pr.reviews, head)) {
    const detail = operative.map((r) => `${r.state}/${r.id}`).join(", ");
    // Name the duplicate-submission shape explicitly. Left as a bare count, an
    // operator reading the hourly audit cannot tell "one verdict posted twice"
    // from "two genuinely different reviews", and those have opposite remedies.
    const reason = duplicateBodyAcrossIdentities(operative)
      ? "the same body submitted under two credentials — one verdict, posted twice (BLO-22916)"
      : "expected at most 1 or the exact App/User APPROVED pair";
    violations.push(
      `I1 PR #${pr.number} @${short}: ${operative.length} operative Ally reviews (${detail}) — ${reason}`,
    );
  }

  const blocking = operative.filter((r) => hasBlockingFindings(r.body));
  const approvals = operative.filter((r) => r.state === "APPROVED");

  for (const review of approvals) {
    if (hasBlockingFindings(review.body)) {
      violations.push(
        `I2a PR #${pr.number} @${short}: review ${review.id} is APPROVED but its body reports a Critical/Important finding`,
      );
    }
    if (hasStillPresentDisposition(review.body)) {
      violations.push(
        `I2c PR #${pr.number} @${short}: review ${review.id} is APPROVED but its body marks a prior finding still-present`,
      );
    }
    // An approval that makes no attestation at all is the strictly worse case:
    // it counts toward `reviewDecision` while claiming nothing about any tree.
    // Seen live on #1114 — a 129-byte APPROVED reading "Approved the current CI
    // head … this head only retriggers checks", satisfying required-review on a
    // PR whose same-head Ally review carried 3 still-present Important
    // findings, with auto-merge armed. Acknowledging a CI retrigger is a
    // comment, never an approval.
    if (attestedHead(review.body) === null) {
      violations.push(
        `I2d PR #${pr.number} @${short}: review ${review.id} is APPROVED but its body makes no "Reviewed head:" attestation — an approval with no review behind it`,
      );
    }
  }

  if (approvals.length > 0 && blocking.length > 0) {
    // Only when the blocker is a *different* review. An APPROVED that reports
    // its own Critical/Important is already covered by I2a; reporting it again
    // as "coexists with" would describe a review as masking itself.
    const approvalIdSet = new Set(approvals.map((r) => r.id));
    const distinctBlocking = blocking.filter((r) => !approvalIdSet.has(r.id));
    if (distinctBlocking.length > 0) {
      const blockingIds = distinctBlocking.map((r) => r.id).join(", ");
      const approvalIds = approvals.map((r) => r.id).join(", ");
      violations.push(
        `I2b PR #${pr.number} @${short}: standing APPROVED (${approvalIds}) coexists with a blocking Ally review (${blockingIds}) — the approval masks the blocker`,
      );
    }
  }

  for (const review of operative) {
    const attested = attestedHead(review.body);
    if (attested && attested !== String(head ?? "").toLowerCase()) {
      violations.push(
        `I3 PR #${pr.number} @${short}: review ${review.id} attests head ${attested.slice(0, 8)} but is now recorded against ${short} — a force-push re-anchored it, so it stands as an attestation of a tree its author never read`,
      );
    }
  }

  return violations;
}

export function findViolations(prs) {
  return (prs ?? []).flatMap((pr) => findPrViolations(pr));
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
      "number,headRefOid",
    ]),
  );

  assertPrListComplete(rows, repo);

  return rows.map((row) => ({
    number: assertHeadSha(row, repo).number,
    headSha: row.headRefOid,
    reviews: JSON.parse(
      gh(["api", `repos/${repo}/pulls/${row.number}/reviews`, "--paginate"]),
    ),
  }));
}

function main() {
  const repo = process.env.ALLY_REVIEW_REPO || "Blockcast/paperclip";
  const prs = fetchOpenPrs(repo);
  const violations = findViolations(prs);

  if (violations.length > 0) {
    console.error(
      `Ally review-consistency guard FAILED for ${repo} (${violations.length} violation(s)):\n`,
    );
    for (const violation of violations) console.error(`  ${violation}`);
    console.error(
      "\nA violation means a PR may present as reviewed or approved without a single " +
        "operative attestation backing its current head. See BLO-19778.",
    );
    process.exit(1);
  }

  console.log(
    `Ally review-consistency guard passed: no attestation conflicts found across ${prs.length} open PR(s) in ${repo}.`,
  );
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule()) {
  main();
}
