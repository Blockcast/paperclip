/**
 * Merge-visible gate for Ally's comment-shaped PR reviews (BLO-21907).
 *
 * GitHub considers only formal pull_request_review objects for reviewDecision.
 * Ally must emit a plain PR comment when it cannot formally review its own
 * App-authored pull request, so Critical/Important findings on that surface
 * otherwise have no effect on merge eligibility.
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

/**
 * Why the verdict carries an `outcome` alongside `state` (BLO-29711).
 *
 * Three distinct situations previously collapsed into a bare `state: "success"`:
 * a head that was reviewed and found clean, a head nothing attests at all, and
 * a head whose review could not be established (unrecognized author, ambiguous
 * attestation). Only the first is evidence of review. Callers — and the tests
 * that pin this behavior — need to tell them apart without pattern-matching on
 * the human-readable `reason` string.
 *
 * The fail-open on "nothing attests this head" is deliberate and load-bearing:
 * this gate only observes the comment-shaped review surface, so a PR reviewed
 * via a formal `pull_request_review` legitimately has no comment to find.
 * Reporting `pending`/`failure` there would deadlock every formally-reviewed
 * PR. Proof-of-review is a separate control; this gate only makes
 * comment-shaped findings merge-visible.
 */
export type CommentReviewGateOutcome =
  /** An Ally comment attests this exact head and reports no unresolved finding. */
  | "clean"
  /** An Ally comment attests this exact head and carries an unresolved finding. */
  | "blocking_finding"
  /** No comment attests this head, but a finding from an earlier head stands undispositioned. */
  | "carried_finding"
  /** Nothing established a comment-shaped review of this head. Not evidence of review. */
  | "not_evaluated";

export type CommentReviewGateVerdict =
  | { state: "success"; outcome: "clean"; reason: string }
  | { state: "success"; outcome: "not_evaluated"; reason: string }
  | { state: "failure"; outcome: "blocking_finding"; reason: string; commentCreatedAt: string }
  | {
      state: "failure";
      outcome: "carried_finding";
      reason: string;
      commentCreatedAt: string;
      carriedFromHeadSha: string;
    };

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

interface AttestingComment {
  comment: CommentReviewGateComment;
  attestedHeadSha: string;
}

/**
 * Latest Ally consolidated-review comment carrying exactly one head
 * attestation, optionally restricted to one head. Comments with an absent or
 * ambiguous attestation are skipped: a required check must not be set from a
 * guess about which head was examined.
 */
function latestAttestingAllyComment(
  comments: CommentReviewGateComment[],
  reviewerBotLogin: string,
  matchHeadSha: string | null,
): AttestingComment | null {
  let latest: AttestingComment | null = null;
  let latestTime = -Infinity;

  for (const comment of comments) {
    if (!isAllyConsolidatedReviewComment(comment, reviewerBotLogin)) continue;
    const attestedHeadSha = extractAllyReviewedHeadSha(comment.body);
    if (!attestedHeadSha) continue;
    if (matchHeadSha !== null && attestedHeadSha !== matchHeadSha) continue;

    const commentTime = toEpochMs(comment.createdAt);
    if (!Number.isFinite(commentTime)) continue;
    // GitHub's issue-comment endpoint is chronological. Prefer the later item
    // when two comments share its second-resolution created_at timestamp.
    if (commentTime >= latestTime) {
      latest = { comment, attestedHeadSha };
      latestTime = commentTime;
    }
  }
  return latest;
}

/**
 * Evaluate only the comment-shaped review surface for one exact PR head.
 * Formal reviews remain owned by GitHub's normal reviewDecision path.
 */
export function evaluateCommentReviewGate(input: {
  comments: CommentReviewGateComment[];
  headSha: string;
  reviewerBotLogin?: string | null;
}): CommentReviewGateVerdict {
  const reviewerBotLogin = input.reviewerBotLogin?.trim() || DEFAULT_PR_REVIEWER_BOT_LOGIN;
  const headSha = input.headSha?.trim();
  if (!headSha) {
    return {
      state: "success",
      outcome: "not_evaluated",
      reason: "No head SHA was supplied to evaluate against.",
    };
  }

  const comments = input.comments ?? [];
  const normalizedHead = headSha.toLowerCase();
  const forHead = latestAttestingAllyComment(comments, reviewerBotLogin, normalizedHead);

  if (forHead) {
    if (hasActionablePrReviewFeedback(forHead.comment.body)) {
      return {
        state: "failure",
        outcome: "blocking_finding",
        reason:
          "Ally's most recent consolidated-review comment for this head carries an unresolved finding.",
        commentCreatedAt: new Date(toEpochMs(forHead.comment.createdAt)).toISOString(),
      };
    }
    return {
      state: "success",
      outcome: "clean",
      reason:
        "Ally's most recent consolidated-review comment for this head reports no unresolved findings.",
    };
  }

  // Nothing attests this head. A finding raised against an earlier head is not
  // dispositioned by replacing that head, so it carries forward rather than
  // going green (BLO-29711). It clears the moment Ally attests the current head
  // — which the push that produced this head already triggers — so this cannot
  // wedge a PR that keeps being reviewed on the same surface.
  const latestAttestation = latestAttestingAllyComment(comments, reviewerBotLogin, null);
  if (latestAttestation && hasActionablePrReviewFeedback(latestAttestation.comment.body)) {
    return {
      state: "failure",
      outcome: "carried_finding",
      reason:
        `An unresolved finding from Ally's review of ${latestAttestation.attestedHeadSha.slice(0, 7)} ` +
        "is still undispositioned; no comment attests the current head.",
      commentCreatedAt: new Date(toEpochMs(latestAttestation.comment.createdAt)).toISOString(),
      carriedFromHeadSha: latestAttestation.attestedHeadSha,
    };
  }

  return {
    state: "success",
    outcome: "not_evaluated",
    reason: "No Ally consolidated-review comment attests to reviewing this head.",
  };
}

/**
 * A green status published under a `review/`-prefixed context reads as "this
 * head was reviewed and was clean". For the `not_evaluated` outcome that
 * reading is false, and no state can fix it: `pending`/`failure` on absence
 * would deadlock every formally-reviewed PR. The only remedy is to publish
 * outside the `review/` namespace, which is a branch-protection-coupled
 * change. Until then this predicate names the condition so it can be asserted
 * against and logged rather than silently shipped (BLO-29711).
 */
export function commentReviewGateVerdictIsMisreadable(
  verdict: CommentReviewGateVerdict,
  context: string,
): boolean {
  return (
    verdict.outcome === "not_evaluated" &&
    verdict.state === "success" &&
    context.trim().toLowerCase().startsWith("review/")
  );
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

const misreadableContextWarnings = new Set<string>();

function warnOnceIfMisreadableContext(verdict: CommentReviewGateVerdict, context: string): void {
  if (!commentReviewGateVerdictIsMisreadable(verdict, context)) return;
  if (misreadableContextWarnings.has(context)) return;
  misreadableContextWarnings.add(context);
  console.warn(
    `[pr-comment-review-gate] Publishing a green not-evaluated verdict under "${context}". ` +
      "A review/-prefixed context reads as review evidence, which this fail-open gate cannot " +
      "provide. Move it outside the review/ namespace once branch protection is updated (BLO-29711).",
  );
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

  warnOnceIfMisreadableContext(verdict, context);

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
