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
 * surface: given a PR's comment history and its current head SHA, does an
 * unresolved comment-shaped finding block that head?
 *
 * Keyed on "newest Ally consolidated-review comment that attests to
 * reviewing THIS EXACT head" (via the comment's own immutable `Reviewed
 * head: <sha>` line — see `extractAllyReviewedHeadSha`), not "any Ally
 * comment exists" or "any Ally comment posted after some inferred push time".
 * An earlier design compared each comment's `created_at` against the head
 * commit's `committer.date` as a "last push" proxy; that date is contributor-
 * controlled (`GIT_COMMITTER_DATE` on the pushed commit), so it can be set to
 * hide a later blocking comment behind a fabricated future timestamp, or to
 * make a backdated replacement head inherit an old clean review it was never
 * actually reviewed at. Binding to the review body's own head attestation
 * instead removes that manipulable intermediary entirely: two things follow
 * from matching on the exact head rather than a time boundary:
 *  - A comment-shaped finding that attests to a different (older) head
 *    described a tree that no longer exists at this one. It must not block
 *    forever; the AC calls this out explicitly.
 *  - A later, clean Ally pass over the same head supersedes an earlier
 *    blocking one, so an addressed-then-re-reviewed sequence clears the gate
 *    without manual intervention.
 *
 * Reuses `hasAllyConsolidatedReviewHeading` / `hasActionablePrReviewFeedback`
 * / `extractAllyReviewedHeadSha` from ally-review-detection.ts (shared with
 * the webhook route and `githubHasReviewerEvidenceForPr`) rather than
 * re-deriving the detection regexes here — those patterns carry a long
 * history of one-off false positives/negatives (BLO-19067, BLO-15942,
 * BLO-18865, #973, #937, #952) that a second copy would be one edit away from
 * silently diverging from.
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
 * The most recent Ally-consolidated-review-shaped comment whose own
 * `Reviewed head:` attestation names this exact `headSha`, or null when none
 * exists — either no Ally comment has landed for this head yet, or every one
 * on record attests to a different (older) head.
 */
function latestAllyCommentForHead(
  comments: CommentReviewGateComment[],
  headSha: string,
  reviewerBotLogin: string,
): CommentReviewGateComment | null {
  const normalizedHead = headSha.trim().toLowerCase();
  let latest: CommentReviewGateComment | null = null;
  let latestTime = -Infinity;
  for (const comment of comments) {
    if (!isAllyConsolidatedReviewComment(comment, reviewerBotLogin)) continue;
    const reviewedHead = extractAllyReviewedHeadSha(comment.body);
    if (reviewedHead !== normalizedHead) continue;
    const commentTime = toEpochMs(comment.createdAt);
    if (!Number.isFinite(commentTime)) continue;
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
  headSha: string;
  reviewerBotLogin?: string | null;
}): CommentReviewGateVerdict {
  const reviewerBotLogin = input.reviewerBotLogin?.trim() || DEFAULT_PR_REVIEWER_BOT_LOGIN;
  const headSha = input.headSha?.trim();
  if (!headSha) {
    return { state: "success", reason: "No head SHA was supplied to evaluate against." };
  }
  const latest = latestAllyCommentForHead(input.comments ?? [], headSha, reviewerBotLogin);

  if (!latest) {
    return {
      state: "success",
      reason: "No Ally consolidated-review comment attests to reviewing this head.",
    };
  }

  if (hasActionablePrReviewFeedback(latest.body)) {
    return {
      state: "failure",
      reason:
        "Ally's most recent consolidated-review comment for this head carries an unresolved finding.",
      commentCreatedAt: new Date(toEpochMs(latest.createdAt)).toISOString(),
    };
  }

  return {
    state: "success",
    reason: "Ally's most recent consolidated-review comment for this head reports no unresolved findings.",
  };
}

export type PrCommentReviewGateCheckResult =
  | { posted: true; verdict: CommentReviewGateVerdict }
  | { posted: false; reason: "not_configured" | "fetch_failed" | "post_failed"; postFailure?: string };

// Bounded, in-process retry for the transient GitHub hiccups (5xx, rate
// limit, brief network blip) that would otherwise leave a stale status
// standing indefinitely on a webhook-triggered, fire-and-forget check (no
// caller ever retries this on our behalf). Deliberately NOT a durable,
// cross-process-restart queue — `github-status-delivery-outbox.ts` is that
// pattern for the sibling BLO-17456 gate, keyed to a heartbeat run; this
// checker has no run to key off of (it fires from a bare webhook), so wiring
// it into that outbox would need a schema change out of scope here. A few
// bounded in-process attempts meaningfully shrinks the "stale status survives
// a one-off blip" window without that lift.
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

// Serializes concurrent evaluations for the same (repo, PR, status context)
// so a slow, stale run cannot post its verdict after a faster, fresher run
// already posted a different one — GitHub treats the last status write for a
// context as authoritative, so completion order (not start order) is what
// matters. Each turn still performs its own fresh GitHub fetch *inside* the
// critical section, so whichever turn runs last observes the most current
// comment history and its post is the final, correct one regardless of how
// the two webhook deliveries that triggered them were ordered or delayed.
const gateEvaluationChains = new Map<string, Promise<unknown>>();

function serializeGateEvaluation<T>(key: string, runFn: () => Promise<T>): Promise<T> {
  const previous = gateEvaluationChains.get(key) ?? Promise.resolve();
  const settled = previous.then(runFn, runFn);
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
  if (!context) return { posted: false, reason: "not_configured" };

  const key = `${input.repoFullName}#${input.prNumber}#${context}`;
  return serializeGateEvaluation(key, () => executeCommentReviewGateCheck(input, context, config));
}

async function executeCommentReviewGateCheck(
  input: { repoFullName: string; prNumber: number; headSha?: string | null; prUrl?: string | null },
  context: string,
  config: ReturnType<typeof loadConfig>,
): Promise<PrCommentReviewGateCheckResult> {
  const reviewerBotLogin = config.prReviewerBotLogin.trim() || DEFAULT_PR_REVIEWER_BOT_LOGIN;

  // issue_comment webhook contexts (the primary trigger — Ally's finding
  // arrives as a comment, not tied to a commit) carry no head SHA; resolve
  // the PR's current one rather than skipping the check.
  const headSha =
    input.headSha ||
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
