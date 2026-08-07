/**
 * PR review gate evaluator (BLO-22574).
 *
 * Pure evaluator: given a PR's formal `pull_request_review` objects and its
 * `issues/{n}/comments`, decides whether an assignee-scheduled monitor's
 * `pr:<repo>#<n>:review` gate signal is satisfied.
 *
 * Ally answers on two different GitHub surfaces, and `pulls/{n}/reviews`
 * only ever shows one of them. Ally frequently posts a plain PR **comment**
 * headed `## Ally — Consolidated PR Review` and files no review object at
 * all — verified on `Blockcast/magma#1655` (comment 5185758901, reviews ==
 * []) and previously on `Blockcast/paperclip#929/#942/#948/#951/#952`. A
 * gate that reads only the formal-review surface never converges on those
 * PRs, even after re-arming indefinitely.
 *
 * Staleness on the comment surface is decided from the `Reviewed head:
 * <40-hex>` attestation line the comment carries, compared against the
 * PR's current head — NOT from the comment's timestamp, which cannot tell
 * "read this head" apart from "raced the push". Timestamp-vs-push
 * comparison is only a fallback for the (so-far unobserved) case where that
 * line is absent.
 *
 * Designed as a pure evaluator: no IO, no DB, no clock reads beyond what
 * the caller passes in. The caller is responsible for fetching reviews +
 * comments from GitHub (or replaying a fixture captured at a point in
 * time).
 */

export interface PrReviewGateReviewLite {
  /** Review author login, e.g. "allyblockcast[bot]". */
  authorLogin: string | null;
  /** The commit SHA this review evaluated (`commit_id` in the GitHub API). */
  commitSha: string | null;
  /** ISO timestamp the review was submitted. */
  submittedAt: string;
}

export interface PrReviewGateCommentLite {
  /** Comment author login, e.g. "allyblockcast[bot]". */
  authorLogin: string | null;
  body: string;
  /** ISO timestamp the comment was posted. */
  createdAt: string;
}

export type PrReviewGateSurface = "formal_review" | "comment_review" | "none";

export interface PrReviewGateResult {
  satisfied: boolean;
  /** Which surface produced the satisfying answer. "none" when unsatisfied. */
  surface: PrReviewGateSurface;
  /** The head SHA the satisfying review/comment actually read, when known. */
  reviewedHeadSha: string | null;
  /** True when the latest review/comment on the deciding surface read a stale head. */
  stale: boolean;
  /** Human-readable reason, useful for monitor notes / logs. */
  reason: string;
}

export interface EvaluatePrReviewGateInput {
  /** The PR's current head commit SHA. */
  headSha: string;
  reviews: readonly PrReviewGateReviewLite[];
  comments: readonly PrReviewGateCommentLite[];
  /**
   * ISO timestamp the current head was pushed, when known. Only consulted
   * when a comment-shaped review carries no `Reviewed head:` line — the
   * timestamp-vs-last-push fallback the acceptance criteria describes.
   * Without it, a captureless comment is treated as answering the current
   * head (cannot prove staleness, so it doesn't block convergence).
   */
  headPushedAt?: string | null;
}

/** Matches a `## Ally ...` consolidated-review comment heading, anchored to the start of the body. */
const ALLY_COMMENT_HEADING_PATTERN = /^##\s*Ally\b/;
/** Matches the `Reviewed head: <40-hex>` attestation line inside a comment-shaped review. */
const REVIEWED_HEAD_PATTERN = /Reviewed head:\s*([0-9a-f]{40})/i;

function latestByTimestamp<T>(items: readonly T[], at: (item: T) => string): T | null {
  if (items.length === 0) return null;
  return items.reduce((latest, item) => (at(item) > at(latest) ? item : latest));
}

/**
 * Evaluate whether a PR's `pr:<repo>#<n>:review` gate is satisfied, checking
 * BOTH surfaces GitHub can carry a review on. `reviews` is not returned
 * sorted by GitHub, so this always takes the latest entry per surface
 * before deciding — never the first one encountered.
 */
export function evaluatePrReviewGate(input: EvaluatePrReviewGateInput): PrReviewGateResult {
  const { headSha, reviews, comments, headPushedAt = null } = input;

  const latestReview = latestByTimestamp(reviews, (r) => r.submittedAt);
  if (latestReview) {
    const reviewStale = latestReview.commitSha !== null && latestReview.commitSha !== headSha;
    if (!reviewStale) {
      return {
        satisfied: true,
        surface: "formal_review",
        reviewedHeadSha: latestReview.commitSha,
        stale: false,
        reason: `Formal review by ${latestReview.authorLogin ?? "unknown"} at head ${latestReview.commitSha ?? "unknown"}.`,
      };
    }
  }

  const allyComments = comments.filter((c) => ALLY_COMMENT_HEADING_PATTERN.test(c.body));
  const latestAllyComment = latestByTimestamp(allyComments, (c) => c.createdAt);
  if (latestAllyComment) {
    const capture = latestAllyComment.body.match(REVIEWED_HEAD_PATTERN);
    const reviewedHeadSha = capture ? capture[1] : null;

    let commentStale: boolean;
    if (reviewedHeadSha !== null) {
      // Head comparison, never timestamp — a timestamp can't distinguish
      // "read this head" from "raced the push" (BLO-22574).
      commentStale = reviewedHeadSha.toLowerCase() !== headSha.toLowerCase();
    } else if (headPushedAt !== null) {
      // Fallback only for the genuinely-empty-capture case.
      commentStale = latestAllyComment.createdAt < headPushedAt;
    } else {
      commentStale = false;
    }

    if (!commentStale) {
      return {
        satisfied: true,
        surface: "comment_review",
        reviewedHeadSha,
        stale: false,
        reason: reviewedHeadSha
          ? `Comment-shaped Ally review at head ${reviewedHeadSha}.`
          : "Comment-shaped Ally review with no captured head; treated as current (no `Reviewed head:` line to compare and no stale push evidence).",
      };
    }
    return {
      satisfied: false,
      surface: "none",
      reviewedHeadSha,
      stale: true,
      reason: reviewedHeadSha
        ? `Latest comment-shaped Ally review read stale head ${reviewedHeadSha}, current head is ${headSha}.`
        : `Latest comment-shaped Ally review predates the current head's push and carries no \`Reviewed head:\` line.`,
    };
  }

  if (latestReview) {
    return {
      satisfied: false,
      surface: "none",
      reviewedHeadSha: latestReview.commitSha,
      stale: true,
      reason: `Latest formal review read stale commit ${latestReview.commitSha ?? "unknown"}, current head is ${headSha}.`,
    };
  }

  return {
    satisfied: false,
    surface: "none",
    reviewedHeadSha: null,
    stale: false,
    reason: "No formal review and no comment-shaped Ally review found.",
  };
}
