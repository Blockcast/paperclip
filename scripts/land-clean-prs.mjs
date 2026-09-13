#!/usr/bin/env node

/**
 * Decides which open PRs may be handed to the merge queue, and why each of the
 * rest may not.
 *
 * Nothing currently lands a PR that Ally has already reviewed clean. They sit
 * open until a human notices, which on 2026-09-04 was the third of four
 * measured causes of 101 issues stalled `in_review` for 22-87 days
 * (BLO-32237). This script is the decision; the routine that runs it
 * (BLO-32511) only invokes it and posts the receipt.
 *
 * The classifier is pure and exhaustive: every PR gets exactly one row, and a
 * row is either an action or a named reason for inaction. There is no "no
 * opinion" outcome, because a PR silently absent from the receipt is
 * indistinguishable from one the script never fetched — the fail-open shape
 * `assertPrListComplete` exists to prevent one layer up.
 *
 * Default is a dry run. `--apply` performs the actions.
 *
 * ## Why the review verdict is read from the body, not from `commit_id`
 *
 * GitHub rewrites `commit_id` on APPROVED reviews when the head moves, so a
 * review can be recorded against a commit created after it was submitted
 * (measured on #1104, 2026-08-07; see I3 in check-ally-review-consistency.mjs).
 * The body's `Reviewed head:` attestation is the record of which tree was
 * actually read, so `canonicalReviewHead` is the selector here. Using
 * `commit_id` would let a force-push launder a stale review into a current one
 * — and this script's whole output is "merge it", so that failure is fatal.
 *
 * ## Why the *newest* attesting review wins (BLO-32240, Ally 2026-09-07)
 *
 * More than one review may attest the same head. #1418 @958587ad carries two:
 * `5124450619` with 1 Important, then `5125141599` clean 4h45m later, a verdict
 * reconciliation at unchanged head. A classifier that scans all reviews at head
 * and disqualifies on any Important reads that PR as blocked *permanently*,
 * because the superseded review is immortal and the head never moves on its
 * own. So: select the newest attesting operative review by `submitted_at` and
 * judge only that one. This matches the gate's own stated semantics —
 * `gate/ally-comment-findings` describes itself as reading Ally's "most recent"
 * consolidated review for the head.
 *
 * The mirror case is the dangerous one and is tested: older clean, newer
 * blocking must NOT enqueue. A naive "take any clean review at head" passes the
 * first case and fails open on the second.
 *
 * Note this is not in tension with the "exactly one attestation" rule. That
 * rule is about one `Reviewed head:` line per *body* (anti-forgery), enforced
 * by `canonicalReviewHead`; it is not a cap on reviews per head.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  allyReviewLane,
  assertHeadSha,
  assertPrListComplete,
  canonicalReviewHead,
  hasBlockingFindings,
  hasStillPresentDisposition,
  isAllyAppLogin,
} from "./check-ally-review-consistency.mjs";

/**
 * An auto-merge request older than this is treated as wedged rather than
 * pending. The merge queue drains in minutes; a request still outstanding
 * overnight means it was armed against a gate that has since become
 * unsatisfiable, and it blocks re-enqueue because `--auto` is already set. 13h
 * clears a normal overnight queue without waiting a second working day.
 */
export const STALE_ENQUEUE_HOURS = 13;

export const CODEOWNER_REQUEST_MARKER = "<!-- landing-routine:codeowner-request -->";
export const STALE_ENQUEUE_MARKER = "<!-- landing-routine:stale-enqueue -->";

/** Either label is an explicit human "not this one". */
export const SKIP_LABELS = ["do-not-merge", "review-gate-override"];

/**
 * A blast-radius cap, not a throughput target. A classifier bug that says
 * "enqueue" for the wrong reason costs at most this many PRs per fire, and the
 * receipt names every PR the cap deferred so the truncation is never silent.
 */
export const MAX_ENQUEUES_PER_FIRE = 10;

/**
 * SKIPPED and NEUTRAL are passes: a path-filtered job and a soft-reporting one
 * both legitimately decline to run. Everything else — including a null
 * conclusion, which is a check still in flight — is not a verdict of success
 * and must not be read as one.
 */
const PASSING_CHECK_STATES = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Contexts that mirror Ally's review verdict rather than reporting CI.
 *
 * These are excluded from the check rule because the review rule below reads
 * the same fact from the authoritative source, and reads it correctly. The
 * statuses do not: measured on #1681 @c57fafa0 (2026-09-13), the newest
 * attesting review is `Critical Issues (0)` / `Important Issues (0)` — clean,
 * two non-blocking Suggestions — while `gate/ally-comment-findings` sits at
 * `failure` claiming "carries an unresolved finding". Same divergence recorded
 * on #1418 (BLO-32514), where the status was stale for over a day against a
 * verdict it no longer described.
 *
 * Counting them as checks would be a permanent false hold: a commit status
 * never moves on its own, so such a PR could never enqueue however clean its
 * review became. That is the same immortal-stale-verdict failure the
 * newest-review rule exists to prevent, arriving through a different door.
 *
 * Deliberately narrow. It matches only the `review/ally-*` and `gate/ally-*`
 * legacy-status namespace. The bare `review` context is the PR-quality gate and
 * is a real check; any Ally-named *check-run* is the workflow that publishes
 * the status, and is also a real check. Neither is excluded — and that is
 * enforced by `isAllyVerdictStatus` below rather than assumed, because the
 * names are only unambiguous while no check-run happens to share one.
 * Measured on #1821 @5cc6a70e: all three Ally rows are `StatusContext`, so the
 * name-only reading was load-bearing and untyped.
 *
 * This removes a duplicate reading, not a gate. `allyVerdictAtHead` still
 * blocks on Critical/Important findings and on a still-present prior
 * disposition, from the newest review that attests the current head.
 */
const ALLY_VERDICT_STATUS_RE = /^(?:review|gate)\/ally-/i;

/**
 * Merge states that mean the PR cannot land as it stands. BLOCKED and BEHIND
 * are deliberately absent: BLOCKED is the normal state of a PR awaiting the
 * code-owner approval we may have just requested, and BEHIND is what the merge
 * queue exists to resolve. `--auto` waits for both correctly.
 */
const UNLANDABLE_MERGE_STATES = new Set(["DIRTY", "UNSTABLE", "UNKNOWN"]);

function isDismissedOrPending(review) {
  const state = String(review?.state ?? "").toUpperCase();
  return state === "DISMISSED" || state === "PENDING";
}

function lower(value) {
  return String(value ?? "").toLowerCase();
}

/**
 * The latest state per check name.
 *
 * A re-run, or a cancelled-then-superseded run, leaves both attempts hanging
 * off the same head. Reading them all makes a green PR look red (BLO-32733),
 * so the newest row per name wins. `statusCheckRollup` unifies the check-run
 * and legacy commit-status surfaces, which is why this reads one field rather
 * than two endpoints that are each blind to the other.
 */
export function latestCheckStates(rollup) {
  const latest = new Map();
  for (const context of rollup ?? []) {
    const name = String(context?.name ?? context?.context ?? "").trim();
    if (name === "") continue;
    const state = String(
      context?.conclusion || context?.state || context?.status || "PENDING",
    ).toUpperCase();
    const at = Date.parse(
      context?.completedAt || context?.startedAt || context?.createdAt || "",
    );
    const stamp = Number.isFinite(at) ? at : 0;
    const seen = latest.get(name);
    if (!seen || stamp >= seen.stamp) latest.set(name, { state, stamp });
  }
  return new Map([...latest].map(([name, { state }]) => [name, state]));
}

/**
 * A legacy commit status in the Ally verdict-mirror namespace.
 *
 * Keyed on `__typename`, not on the name alone: `statusCheckRollup` unions
 * `CheckRun` and `StatusContext`, so a name-only predicate would also swallow a
 * genuinely failing *check-run* that happened to carry one of these names —
 * contradicting the comment above and letting a PR enqueue past a red required
 * check. Fails safe: if `__typename` is ever absent the row is treated as a
 * real check, which can only over-hold, never over-enqueue.
 */
function isAllyVerdictStatus(context) {
  return (
    context?.__typename === "StatusContext" &&
    ALLY_VERDICT_STATUS_RE.test(String(context?.context ?? ""))
  );
}

export function failingChecks(rollup) {
  return [...latestCheckStates((rollup ?? []).filter((c) => !isAllyVerdictStatus(c)))]
    .filter(([, state]) => !PASSING_CHECK_STATES.has(state))
    .map(([name, state]) => `${name}=${state}`);
}

/** Operative Ally App reviews whose body attests this exact head. */
export function attestingAppReviews(reviews, headSha) {
  const head = lower(headSha);
  return (reviews ?? []).filter(
    (review) =>
      allyReviewLane(review?.user) === "app" &&
      !isDismissedOrPending(review) &&
      canonicalReviewHead(review?.body) === head,
  );
}

/**
 * @returns {{verdict: "clean"|"blocking"|"stale-head"|"missing", review: object|null}}
 */
export function allyVerdictAtHead(pr) {
  const attesting = attestingAppReviews(pr?.reviews, pr?.headRefOid);
  if (attesting.length === 0) {
    const hasOperativeAppReview = (pr?.reviews ?? []).some(
      (review) => allyReviewLane(review?.user) === "app" && !isDismissedOrPending(review),
    );
    return { verdict: hasOperativeAppReview ? "stale-head" : "missing", review: null };
  }

  const newest = attesting.reduce((a, b) =>
    (Date.parse(b?.submitted_at ?? "") || 0) >= (Date.parse(a?.submitted_at ?? "") || 0) ? b : a,
  );
  const blocking =
    hasBlockingFindings(newest.body) || hasStillPresentDisposition(newest.body);
  return { verdict: blocking ? "blocking" : "clean", review: newest };
}

/**
 * Requested reviewers with no APPROVED review at the current head.
 *
 * D7: GitHub does not enforce CODEOWNERS on this repo, so an outstanding owner
 * request is a real gate that only this script observes. A team request can
 * never be satisfied by a login match and so always counts as outstanding,
 * which is correct — a team has not reviewed until one of its members has.
 *
 * This matches on `commit_id` rather than a body attestation because a human
 * approval carries no attestation to read. That inherits GitHub's own
 * re-anchoring behaviour on force-push, i.e. it can read a re-anchored stale
 * approval as current. The residual is bounded by `dismiss_stale_reviews_on_push`
 * server-side, and the direction matches what GitHub's own merge gate would do.
 */
export function unsatisfiedOwners(pr) {
  const head = lower(pr?.headRefOid);
  const approved = new Set(
    (pr?.reviews ?? [])
      .filter(
        (review) =>
          String(review?.state ?? "").toUpperCase() === "APPROVED" &&
          lower(review?.commit_id) === head,
      )
      .map((review) => lower(review?.user?.login)),
  );
  return (pr?.reviewRequests ?? [])
    .map((request) =>
      request?.login ? String(request.login) : request?.slug ? `team:${request.slug}` : null,
    )
    .filter((who) => who !== null && !approved.has(lower(who)));
}

/**
 * The rules decidable from `gh pr list` alone, or null when this PR needs its
 * checks and reviews fetched.
 *
 * Split out because `statusCheckRollup` is expensive: asking for it across all
 * 139 open PRs in one GraphQL call returns 502/504 (measured 2026-09-13 at
 * limits 150, 200 and 500). Deciding the cheap rules first means only the PRs
 * that survive them cost two API calls each, and on a repo where most open PRs
 * are already enqueued or human-authored that is most of them avoided.
 */
export function classifyFromListing(pr, { now = Date.now() } = {}) {
  const row = (action, reason, detail = null) => ({
    number: pr?.number,
    headSha: pr?.headRefOid,
    action,
    reason,
    detail,
  });

  if (!isAllyAppLogin(pr?.author?.login) || pr?.author?.is_bot !== true) {
    return row("skip", "human-author", pr?.author?.login ?? "<unknown>");
  }

  const labels = (pr?.labels ?? []).map((label) => lower(label?.name));
  const optOut = SKIP_LABELS.find((label) => labels.includes(label));
  if (optOut) return row("skip", `label:${optOut}`);

  if (pr?.autoMergeRequest) {
    const enabledAt = Date.parse(pr.autoMergeRequest.enabledAt ?? "");
    // An unparseable timestamp must not read as infinitely old: treating it as
    // fresh leaves the PR alone, which is the recoverable direction.
    const ageHours = Number.isFinite(enabledAt) ? (now - enabledAt) / 3_600_000 : 0;
    if (ageHours > STALE_ENQUEUE_HOURS) {
      return row("stale-enqueue", `auto-merge armed ${ageHours.toFixed(1)}h ago`);
    }
    return row("already-enqueued", `auto-merge armed ${ageHours.toFixed(1)}h ago`);
  }

  return null;
}

/**
 * One row per PR. Rules are ordered so that the reason reported is the one a
 * human would act on first: an explicit opt-out beats a red check, and a red
 * check beats a missing review, because fixing the review would not help.
 */
export function classifyPr(pr, { now = Date.now() } = {}) {
  const fromListing = classifyFromListing(pr, { now });
  if (fromListing) return fromListing;

  const row = (action, reason, detail = null) => ({
    number: pr?.number,
    headSha: pr?.headRefOid,
    action,
    reason,
    detail,
  });

  const failing = failingChecks(pr?.statusCheckRollup);
  if (failing.length > 0) {
    return row("skip", `checks:${failing[0].split("=")[1]}`, failing.join(", "));
  }

  const { verdict } = allyVerdictAtHead(pr);
  if (verdict !== "clean") return row("skip", `review:${verdict}`);

  const owners = unsatisfiedOwners(pr);
  if (owners.length > 0) {
    return row("codeowner-review-requested", "owner-approval-pending", owners.join(", "));
  }

  const mergeState = String(pr?.mergeStateStatus ?? "UNKNOWN").toUpperCase();
  if (UNLANDABLE_MERGE_STATES.has(mergeState)) return row("skip", `mergestate:${mergeState}`);

  return row("enqueue", `mergestate:${mergeState}`);
}

/** Classifies every PR and applies the per-fire enqueue cap. */
export function classifyAll(prs, { now = Date.now(), maxEnqueues = MAX_ENQUEUES_PER_FIRE } = {}) {
  let enqueued = 0;
  return (prs ?? []).map((pr) => {
    const classified = classifyPr(pr, { now });
    if (classified.action !== "enqueue") return classified;
    if (enqueued >= maxEnqueues) {
      return { ...classified, action: "skip", reason: `cap:${maxEnqueues}-per-fire` };
    }
    enqueued += 1;
    return classified;
  });
}

/**
 * A gh failure that means the whole fire is untrustworthy rather than this one
 * PR being awkward. Continuing past exhausted rate limits or bad credentials
 * would produce a receipt whose `skip:` rows are indistinguishable from real
 * verdicts, so the fire aborts and says so.
 */
export function isFatalGhError(message) {
  return /rate limit|bad credentials|HTTP 40[13]|could not read (?:Username|Password)/i.test(
    String(message ?? ""),
  );
}

export function renderReceipt(rows) {
  const lines = [
    "| PR | action | reason | detail |",
    "| --- | --- | --- | --- |",
    ...(rows ?? []).map(
      (r) => `| #${r.number} | \`${r.action}\` | \`${r.reason}\` | ${r.detail ?? ""} |`,
    ),
  ];
  const tally = new Map();
  for (const r of rows ?? []) tally.set(r.action, (tally.get(r.action) ?? 0) + 1);
  lines.push(
    "",
    [...tally].sort().map(([action, count]) => `${action}: ${count}`).join(" · ") ||
      "no open PRs",
  );
  return lines.join("\n");
}

const PR_LIST_FIELDS =
  "number,headRefOid,author,labels,autoMergeRequest,mergeStateStatus,reviewRequests";

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Lists open PRs, then hydrates checks and reviews only for the ones the cheap
 * rules could not decide. `statusCheckRollup` is deliberately absent from the
 * list query — including it makes GitHub time out across this repo's open PR
 * count — so it is fetched per PR alongside the REST reviews.
 *
 * Reviews come from REST rather than `gh pr view --json reviews` because the
 * identity rules pin immutable REST account IDs, which the GraphQL shape does
 * not carry. A login string alone is not review evidence (I5).
 */
function fetchOpenPrs(repo) {
  const rows = JSON.parse(
    gh(["pr", "list", "--repo", repo, "--state", "open", "--limit", "500", "--json", PR_LIST_FIELDS]),
  );
  assertPrListComplete(rows, repo, 500);
  return rows.map((row) => {
    assertHeadSha(row, repo);
    if (classifyFromListing(row)) return row;
    return {
      ...row,
      statusCheckRollup: JSON.parse(
        gh(["pr", "view", String(row.number), "--repo", repo, "--json", "statusCheckRollup"]),
      ).statusCheckRollup,
      reviews: JSON.parse(gh(["api", `repos/${repo}/pulls/${row.number}/reviews`, "--paginate"])),
    };
  });
}

/** Posts `body` unless a comment carrying `marker` is already on the PR. */
function commentOnce(repo, number, marker, body) {
  const existing = JSON.parse(
    gh(["api", `repos/${repo}/issues/${number}/comments`, "--paginate"]),
  );
  if (existing.some((comment) => String(comment?.body ?? "").includes(marker))) return "already-posted";
  gh(["pr", "comment", String(number), "--repo", repo, "--body", `${marker}\n${body}`]);
  return "posted";
}

function applyRow(repo, row) {
  if (row.action === "enqueue") {
    gh(["pr", "merge", String(row.number), "--repo", repo, "--auto"]);
    return "auto-merge armed";
  }
  if (row.action === "stale-enqueue") {
    gh(["pr", "merge", String(row.number), "--repo", repo, "--disable-auto"]);
    return commentOnce(
      repo,
      row.number,
      STALE_ENQUEUE_MARKER,
      `Auto-merge had been armed for over ${STALE_ENQUEUE_HOURS}h without landing, so the landing ` +
        `routine disarmed it. It will re-arm on the next fire once this PR classifies clean.`,
    );
  }
  if (row.action === "codeowner-review-requested") {
    return commentOnce(
      repo,
      row.number,
      CODEOWNER_REQUEST_MARKER,
      `This PR is clean at its current head but still has an outstanding code-owner review ` +
        `request (${row.detail}). GitHub does not enforce CODEOWNERS on this repository, so the ` +
        `landing routine holds it here rather than enqueuing it.`,
    );
  }
  return null;
}

function main() {
  const repo = process.env.LAND_CLEAN_PRS_REPO || "Blockcast/paperclip";
  const apply = process.argv.includes("--apply");
  const rows = classifyAll(fetchOpenPrs(repo));

  for (const row of rows) {
    if (!apply) continue;
    try {
      const outcome = applyRow(repo, row);
      if (outcome) row.detail = [row.detail, outcome].filter(Boolean).join(" — ");
    } catch (error) {
      const message = error?.stderr?.toString() || error?.message || String(error);
      if (isFatalGhError(message)) {
        row.action = "aborted";
        row.detail = message.trim().split("\n")[0];
        console.log(renderReceipt(rows));
        console.error(`\nAborted the fire: ${row.detail}`);
        process.exit(1);
      }
      row.detail = [row.detail, `failed: ${message.trim().split("\n")[0]}`]
        .filter(Boolean)
        .join(" — ");
    }
  }

  console.log(renderReceipt(rows));
  if (!apply) console.log("\n(dry run — pass --apply to act)");
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule()) {
  main();
}
