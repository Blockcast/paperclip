/**
 * BLO-21907: gate-side check for Ally's comment-shaped reviews.
 *
 * Ally reviews a PR on two surfaces. Sometimes it submits a formal
 * `pull_request_review`, which GitHub's `reviewDecision` and `mergeStateStatus`
 * both read. Sometimes — always on a self-authored PR, since the Ally GitHub
 * App cannot review its own PR — it posts a plain issue comment headed
 * `## Ally — Consolidated PR Review` instead. That comment opens no review
 * thread and is invisible to `reviewDecision`, so an unaddressed "before
 * merge" finding on that surface has zero effect on merge eligibility.
 *
 * Observed live on Blockcast/paperclip#1022: Ally posted an Important finding
 * as a bare comment at 20:09:19Z ("Make Lane C progress ... before merge"), a
 * formal review APPROVED the PR at 21:14:37Z on the strength of "no unresolved
 * review threads" (vacuously true — Ally never opens threads), and the PR
 * entered the merge queue minutes later with the finding still outstanding.
 *
 * This module answers one question in isolation from that formal-review
 * surface: given a PR's comment history and the timestamp of its most recent
 * push, does an unresolved comment-shaped finding block the current head?
 *
 * Keyed on "newest Ally consolidated-review comment SINCE the last push", not
 * "any Ally comment exists" — two things follow from that:
 *  - A comment-shaped finding that predates the current push described a tree
 *    that no longer exists at this head. It must not block forever; the AC
 *    calls this out explicitly.
 *  - A later, clean Ally pass over the same head supersedes an earlier
 *    blocking one, so an addressed-then-re-reviewed sequence clears the gate
 *    without manual intervention.
 *
 * Reuses `hasAllyConsolidatedReviewHeading` / `hasActionablePrReviewFeedback`
 * from ally-review-detection.ts (shared with the webhook route) rather than
 * re-deriving the detection regexes here — those patterns carry a long
 * history of one-off false positives/negatives (BLO-19067, BLO-15942,
 * BLO-18865, #973, #937, #952) that a second copy would be one edit away from
 * silently diverging from.
 */

import { loadConfig } from "../config.js";
import {
  hasActionablePrReviewFeedback,
  hasAllyConsolidatedReviewHeading,
} from "./ally-review-detection.js";
import {
  githubFetchPrHeadSha,
  githubGetCommitCommittedAt,
  githubListIssueCommentsWithTimestamps,
  githubPostCommitStatusDetailed,
  githubReviewerIdentityMatches,
} from "./github-app-auth.js";

const DEFAULT_PR_REVIEWER_BOT_LOGIN = "allyblockcast[bot]";

export interface CommentReviewGateComment {
  /** GitHub login for the comment author. Must match the configured Ally App identity. */
  authorLogin: string | null | undefined;
  body: string | null | undefined;
  /** ISO 8601 string or Date; the comment's `created_at`. */
  createdAt: string | Date;
}

export type CommentReviewGateVerdict =
  | { state: "success"; reason: string }
  | { state: "failure"; reason: string; commentCreatedAt: string };

function toEpochMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function isAllyConsolidatedReviewComment(
  comment: CommentReviewGateComment,
  reviewerBotLogin: string,
): boolean {
  const authorLogin = comment.authorLogin?.trim();
  return Boolean(
    authorLogin &&
    githubReviewerIdentityMatches(authorLogin, reviewerBotLogin) &&
    hasAllyConsolidatedReviewHeading(comment.body),
  );
}

/**
 * The most recent Ally-consolidated-review-shaped comment posted strictly
 * after `lastPushAt`, or null when none exists — either no Ally comment has
 * landed yet, or every one on record predates (or ties) the push.
 */
function latestAllyCommentSincePush(
  comments: CommentReviewGateComment[],
  lastPushAt: string | Date,
  reviewerBotLogin: string,
): CommentReviewGateComment | null {
  const pushTime = toEpochMs(lastPushAt);
  let latest: CommentReviewGateComment | null = null;
  let latestTime = -Infinity;
  for (const comment of comments) {
    if (!isAllyConsolidatedReviewComment(comment, reviewerBotLogin)) continue;
    const commentTime = toEpochMs(comment.createdAt);
    if (!Number.isFinite(commentTime) || !(commentTime > pushTime)) continue;
    if (commentTime > latestTime) {
      latest = comment;
      latestTime = commentTime;
    }
  }
  return latest;
}

/**
 * Evaluate the comment-shaped review gate for a PR's current head.
 *
 * Deliberately blind to formal `pull_request_review` objects: those already
 * drive `reviewDecision` today, and this predicate exists to cover the
 * surface that doesn't. Mixing the two here would risk this gate failing (or
 * passing) a PR for a reason the existing, unmodified `REQUEST_CHANGES` path
 * already owns.
 */
export function evaluateCommentReviewGate(input: {
  comments: CommentReviewGateComment[];
  lastPushAt: string | Date;
  reviewerBotLogin?: string | null;
}): CommentReviewGateVerdict {
  const reviewerBotLogin = input.reviewerBotLogin?.trim() || DEFAULT_PR_REVIEWER_BOT_LOGIN;
  const latest = latestAllyCommentSincePush(input.comments ?? [], input.lastPushAt, reviewerBotLogin);

  if (!latest) {
    return {
      state: "success",
      reason: "No Ally consolidated-review comment since the last push.",
    };
  }

  if (hasActionablePrReviewFeedback(latest.body)) {
    return {
      state: "failure",
      reason:
        "Ally's most recent consolidated-review comment since the last push carries an unresolved finding.",
      commentCreatedAt: new Date(toEpochMs(latest.createdAt)).toISOString(),
    };
  }

  return {
    state: "success",
    reason: "Ally's most recent consolidated-review comment since the last push reports no unresolved findings.",
  };
}

export type PrCommentReviewGateCheckResult =
  | { posted: true; verdict: CommentReviewGateVerdict }
  | { posted: false; reason: "not_configured" | "fetch_failed" | "post_failed"; postFailure?: string };

/**
 * Live entry point: evaluate BLO-21907's gate for one PR head against GitHub
 * and, when configured, post the required-check status GitHub's merge gate
 * can read.
 *
 * Fully inert until an operator sets `PAPERCLIP_PR_COMMENT_REVIEW_GATE_STATUS_CONTEXT`
 * — same opt-in shape as the existing `prReviewGateStatusContext` (BLO-17456):
 * the context name belongs to whoever owns branch protection, not to this
 * server, and marking it *required* on `master` is the human-only half of
 * this issue's acceptance criteria (agent tokens get 403 reading protection).
 *
 * Never throws: a fetch or post failure returns `{ posted: false, reason }`
 * for the caller to log, so a GitHub hiccup degrades to "no status change"
 * rather than taking down whatever triggered this check.
 */
export async function runPrCommentReviewGateCheck(input: {
  repoFullName: string;
  prNumber: number;
  headSha?: string | null;
  prUrl?: string | null;
}): Promise<PrCommentReviewGateCheckResult> {
  const config = loadConfig();
  const context = config.prCommentReviewGateStatusContext.trim();
  const reviewerBotLogin = config.prReviewerBotLogin.trim() || DEFAULT_PR_REVIEWER_BOT_LOGIN;
  if (!context) return { posted: false, reason: "not_configured" };

  // issue_comment webhook contexts (the primary trigger — Ally's finding
  // arrives as a comment, not tied to a commit) carry no head SHA; resolve
  // the PR's current one rather than skipping the check.
  const headSha =
    input.headSha ||
    (await githubFetchPrHeadSha({ repoFullName: input.repoFullName, prNumber: input.prNumber }));
  if (!headSha) return { posted: false, reason: "fetch_failed" };

  const [comments, lastPushAt] = await Promise.all([
    githubListIssueCommentsWithTimestamps({ repoFullName: input.repoFullName, prNumber: input.prNumber }),
    githubGetCommitCommittedAt({ repoFullName: input.repoFullName, sha: headSha }),
  ]);
  if (comments == null || lastPushAt == null) return { posted: false, reason: "fetch_failed" };

  const verdict = evaluateCommentReviewGate({
    comments: comments.map((comment) => ({
      authorLogin: comment.login,
      body: comment.body,
      createdAt: comment.createdAt,
    })),
    lastPushAt,
    reviewerBotLogin,
  });

  const posted = await githubPostCommitStatusDetailed({
    repoFullName: input.repoFullName,
    sha: headSha,
    context,
    state: verdict.state,
    description: verdict.reason,
    targetUrl: input.prUrl ?? null,
  });
  if (!posted.ok) return { posted: false, reason: "post_failed", postFailure: posted.reason };

  return { posted: true, verdict };
}
