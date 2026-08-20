/**
 * Merge-visible gate for Ally's comment-shaped PR reviews (BLO-21907).
 *
 * GitHub considers only formal pull_request_review objects for reviewDecision.
 * Ally must emit a plain PR comment when it cannot formally review its own
 * App-authored pull request, so Critical/Important findings on that surface
 * otherwise have no effect on merge eligibility.
 *
 * SCOPE — this context speaks for the COMMENT surface only (BLO-28988).
 *
 * It answers exactly one question: "does Ally's comment-shaped review carry an
 * unresolved finding against this head?" It is NOT a "was this head reviewed at
 * all" gate, and must not be widened into one. Ally reviews most pull requests
 * through a formal `pull_request_review` object (`COMMENTED`) and posts no
 * comment-shaped review at all, so on those the comment surface is simply not
 * engaged and there is nothing here to block. Reporting a non-success state for
 * that case would red-flag every healthy pull request — the same failure mode
 * `values.blockcast.yaml` already documents for the sibling
 * `prReviewGateStatusContext` ("would leave every healthy PR at 'Expected —
 * waiting for status' forever").
 *
 * Whether a head must be reviewed by *someone* is a branch-protection policy
 * question owned by the formal surface (`reviewDecision`) — see BLO-26602 and
 * BLO-20673. Do not answer it here by overloading this context.
 *
 * What this file must never do is emit `success` alongside a description that
 * asserts a deficiency: that pairing reads as "gate passed" while claiming
 * nothing attests to the head, which is what BLO-28988 was filed about. Every
 * `success` reason below states what was checked and why nothing blocks.
 */
import { loadConfig } from "../config.js";
import {
  extractAllyReviewedHeadSha,
  hasActionablePrReviewFeedback,
  hasAllyConsolidatedReviewHeading,
} from "./ally-review-detection.js";
import {
  githubFetchPrHeadSha,
  githubListIssueCommentsWithTimestamps,
  githubPostCommitStatusDetailed,
  githubReviewerIdentityMatches,
  type GitHubCommitStatusPostResult,
} from "./github-app-auth.js";

const DEFAULT_PR_REVIEWER_BOT_LOGIN = "allyblockcast[bot]";

export interface CommentReviewGateComment {
  authorLogin: string | null | undefined;
  body: string | null | undefined;
  createdAt: string | Date;
}

export type CommentReviewGateVerdict =
  | { state: "success"; reason: string }
  | { state: "pending"; reason: string }
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
 * Latest comment-shaped Ally review, optionally restricted to one exact head.
 * Pass `requiredHead: null` to find the most recent one whatever head it named.
 */
function latestAllyReviewComment(
  comments: CommentReviewGateComment[],
  reviewerBotLogin: string,
  requiredHead: string | null,
): CommentReviewGateComment | null {
  let latest: CommentReviewGateComment | null = null;
  let latestTime = -Infinity;

  for (const comment of comments) {
    if (!isAllyConsolidatedReviewComment(comment, reviewerBotLogin)) continue;
    if (requiredHead !== null && extractAllyReviewedHeadSha(comment.body) !== requiredHead) continue;

    const commentTime = toEpochMs(comment.createdAt);
    if (!Number.isFinite(commentTime)) continue;
    // GitHub's issue-comment endpoint is chronological. Prefer the later item
    // when two comments share its second-resolution created_at timestamp.
    if (commentTime >= latestTime) {
      latest = comment;
      latestTime = commentTime;
    }
  }
  return latest;
}

/**
 * Evaluate only the comment-shaped review surface for one exact PR head.
 * Formal reviews remain owned by GitHub's normal reviewDecision path — see the
 * SCOPE note at the top of this file before widening any branch here.
 *
 * State meanings, all scoped to the comment surface:
 *   failure — a comment-shaped review of THIS head carries an unresolved finding.
 *   pending — the surface could not be evaluated at all. Not a pass: reporting
 *             success would assert a clean surface we never actually read.
 *   success — nothing on this surface blocks. Each success reason states which
 *             case applied, so a green status is never paired with a description
 *             a reader can mistake for a deficiency (BLO-28988).
 *
 * A finding deliberately does NOT carry across a replacement head: only an
 * exact-head attestation gates, so a stale comment cannot block a head that may
 * already contain the fix (BLO-21907 / #1262). Requiring a *fresh* re-review to
 * go green would additionally couple this gate to reviewer delivery, the least
 * reliable link in the chain (BLO-28920, BLO-28968). The superseded case
 * therefore gets its own reason string rather than its own state.
 */
export function evaluateCommentReviewGate(input: {
  comments: CommentReviewGateComment[];
  headSha: string;
  reviewerBotLogin?: string | null;
}): CommentReviewGateVerdict {
  const reviewerBotLogin = input.reviewerBotLogin?.trim() || DEFAULT_PR_REVIEWER_BOT_LOGIN;
  const headSha = input.headSha?.trim();
  // An inability to evaluate is not a pass. Reporting success here would assert
  // a clean surface we never read.
  if (!headSha) {
    return { state: "pending", reason: "Comment-review surface not evaluated: no head SHA was supplied." };
  }

  const comments = input.comments ?? [];
  const normalizedHead = headSha.toLowerCase();
  const latestForHead = latestAllyReviewComment(comments, reviewerBotLogin, normalizedHead);

  if (latestForHead) {
    if (hasActionablePrReviewFeedback(latestForHead.body)) {
      return {
        state: "failure",
        reason:
          "Ally's most recent consolidated-review comment for this head carries an unresolved finding.",
        commentCreatedAt: new Date(toEpochMs(latestForHead.createdAt)).toISOString(),
      };
    }
    return {
      state: "success",
      reason: "Ally's consolidated-review comment for this head reports no unresolved findings.",
    };
  }

  // Nothing attests to this head. Name which case it is, so a reader can tell a
  // superseded earlier review apart from a surface that was never engaged. Both
  // pass: see the note above on why a finding does not carry across heads.
  if (latestAllyReviewComment(comments, reviewerBotLogin, null)) {
    return {
      state: "success",
      reason: "No comment-review finding for this head; an earlier head's review does not carry over.",
    };
  }

  return {
    state: "success",
    reason: "Comment-review surface clear: no Ally comment-shaped review gates this head.",
  };
}

export type PrCommentReviewGateCheckResult =
  | { posted: true; verdict: CommentReviewGateVerdict }
  | { posted: false; reason: "not_configured" | "fetch_failed" | "post_failed"; postFailure?: string };

export interface PrCommentReviewGateCheckInput {
  repoFullName: string;
  prNumber: number;
  headSha?: string | null;
  prUrl?: string | null;
}

const TRANSIENT_RETRY_DELAYS_MS = [250, 1000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withBoundedRetry<T>(attempt: () => Promise<T>, shouldRetry: (result: T) => boolean): Promise<T> {
  let result = await attempt();
  for (const delayMs of TRANSIENT_RETRY_DELAYS_MS) {
    if (!shouldRetry(result)) break;
    await sleep(delayMs);
    result = await attempt();
  }
  return result;
}

// GitHub accepts the most recently written status for a context as
// authoritative. Serialize evaluations for the same PR/context and fetch
// fresh state inside each turn, so a delayed older snapshot cannot overwrite a
// verdict computed by a newer webhook delivery.
const gateEvaluationChains = new Map<string, Promise<unknown>>();

function serializeGateEvaluation<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = gateEvaluationChains.get(key) ?? Promise.resolve();
  const settled = previous.then(run, run);
  const tracked = settled.then(
    () => undefined,
    () => undefined,
  );
  gateEvaluationChains.set(key, tracked);
  void tracked.then(() => {
    if (gateEvaluationChains.get(key) === tracked) gateEvaluationChains.delete(key);
  });
  return settled;
}

/**
 * Fetch comment history and publish the opt-in commit status. A missing
 * context makes this a strict no-op, so deployments retain current behavior
 * until their branch rules explicitly require the new status.
 */
export async function runPrCommentReviewGateCheck(
  input: PrCommentReviewGateCheckInput,
): Promise<PrCommentReviewGateCheckResult> {
  const config = loadConfig();
  const context = config.prCommentReviewGateStatusContext.trim();
  if (!context) return { posted: false, reason: "not_configured" };

  const key = `${input.repoFullName}#${input.prNumber}#${context}`;
  return serializeGateEvaluation(key, () => executeCommentReviewGateCheck(input, context, config));
}

async function executeCommentReviewGateCheck(
  input: PrCommentReviewGateCheckInput,
  context: string,
  config: ReturnType<typeof loadConfig>,
): Promise<PrCommentReviewGateCheckResult> {
  const reviewerBotLogin = config.prReviewerBotLogin.trim() || DEFAULT_PR_REVIEWER_BOT_LOGIN;
  const headSha =
    input.headSha?.trim() ||
    (await withBoundedRetry(
      () => githubFetchPrHeadSha({ repoFullName: input.repoFullName, prNumber: input.prNumber }),
      (sha) => sha == null,
    ));
  if (!headSha) return { posted: false, reason: "fetch_failed" };

  const comments = await withBoundedRetry(
    () => githubListIssueCommentsWithTimestamps({ repoFullName: input.repoFullName, prNumber: input.prNumber }),
    (result) => result == null,
  );
  if (comments == null) return { posted: false, reason: "fetch_failed" };

  const verdict = evaluateCommentReviewGate({
    comments: comments.map((comment) => ({
      authorLogin: comment.login,
      body: comment.body,
      createdAt: comment.createdAt,
    })),
    headSha,
    reviewerBotLogin,
  });

  const posted = await withBoundedRetry<GitHubCommitStatusPostResult>(
    () =>
      githubPostCommitStatusDetailed({
        repoFullName: input.repoFullName,
        sha: headSha,
        context,
        state: verdict.state,
        description: verdict.reason,
        targetUrl: input.prUrl ?? null,
      }),
    (result) => !result.ok && result.retryable,
  );
  if (!posted.ok) return { posted: false, reason: "post_failed", postFailure: posted.reason };

  return { posted: true, verdict };
}
