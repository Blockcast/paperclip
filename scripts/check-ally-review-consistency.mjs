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
 *   I1  At most one operative Ally verdict per (PR, head SHA).
 *   I2  No operative Ally APPROVED whose own body reports a Critical or
 *       Important finding, and no operative APPROVED coexisting at a SHA with
 *       an operative Ally review that does.
 *   I3  An operative Ally review's body-attested `Reviewed head:` matches the
 *       commit GitHub recorded it against. `gh pr review` attaches a review to
 *       whatever the head is at submit time, so a mid-review push silently
 *       certifies a tree that was never read (seen on #870: body attested
 *       b3a240ec, commit_id was 67965f1e).
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

/**
 * @param {{number: number, headSha: string, reviews: object[]}} pr
 * @returns {string[]} human-readable violations; empty when the PR is sound
 */
export function findPrViolations(pr) {
  const head = pr.headSha;
  const short = String(head ?? "").slice(0, 8);
  const operative = operativeAllyReviews(pr.reviews, head);
  const violations = [];

  if (operative.length > 1) {
    const detail = operative.map((r) => `${r.state}/${r.id}`).join(", ");
    violations.push(
      `I1 PR #${pr.number} @${short}: ${operative.length} operative Ally verdicts (${detail}) — expected at most 1`,
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
        `I3 PR #${pr.number} @${short}: review ${review.id} attests head ${attested.slice(0, 8)} but GitHub recorded it against ${short} — it certifies a tree it never reviewed`,
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
    number: row.number,
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
