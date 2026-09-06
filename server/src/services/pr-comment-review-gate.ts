/**
 * Merge-visible gate for Ally's comment-shaped PR reviews (BLO-21907).
 *
 * GitHub considers only APPROVED/CHANGES_REQUESTED pull_request_review objects
 * for reviewDecision. Ally reviews its own App-authored pull requests, which it
 * cannot formally approve or request changes on, so its Critical/Important
 * findings otherwise have no effect on merge eligibility.
 *
 * "Comment-shaped" is about the *review state*, not the API surface. Ally
 * carries that review as either a `COMMENTED` pull_request_review or a plain
 * issue comment, and both are read here — reading only issue comments left this
 * gate unable to observe any real review (BLO-29711).
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
  githubListPrReviewsWithTimestamps,
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
 * Latest Ally consolidated-review comment attesting exactly one head, matching
 * the requested head. Comments with an absent or ambiguous attestation are
 * skipped: a required check must not be set from a guess about which head was
 * examined.
 */
function latestAttestingAllyComment(
  comments: CommentReviewGateComment[],
  reviewerBotLogin: string,
  matchHeadSha: string,
): AttestingComment | null {
  let latest: AttestingComment | null = null;
  let latestTime = -Infinity;

  for (const comment of comments) {
    if (!isAllyConsolidatedReviewComment(comment, reviewerBotLogin)) continue;
    const attestedHeadSha = extractAllyReviewedHeadSha(comment.body);
    if (!attestedHeadSha) continue;
    if (attestedHeadSha !== matchHeadSha) continue;

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
 * Heads whose own newest attestation still carries an unresolved finding,
 * newest attestation first.
 *
 * Disposition is tracked per attested head, not by global comment recency. A
 * later clean attestation of head H disposes a finding raised against H: Ally
 * re-examined that exact tree and found nothing. A clean attestation of some
 * *other* head does not, because nothing available here establishes that the
 * other head contains the fix — comment chronology is not commit ancestry, and
 * reviews can land out of order relative to pushes.
 *
 * Reading only the globally newest attestation instead let A(blocking) ->
 * B(clean) -> C(unattested) drop A's finding silently (BLO-29711, Ally review
 * of #1464).
 */
function headsWithUndispositionedFinding(
  comments: CommentReviewGateComment[],
  reviewerBotLogin: string,
): AttestingComment[] {
  const newestPerHead = new Map<string, { attesting: AttestingComment; timeMs: number }>();

  for (const comment of comments) {
    if (!isAllyConsolidatedReviewComment(comment, reviewerBotLogin)) continue;
    const attestedHeadSha = extractAllyReviewedHeadSha(comment.body);
    if (!attestedHeadSha) continue;
    const commentTime = toEpochMs(comment.createdAt);
    if (!Number.isFinite(commentTime)) continue;

    const existing = newestPerHead.get(attestedHeadSha);
    // Ties prefer the later item, matching latestAttestingAllyComment: the
    // comment endpoint is chronological but its timestamps are second-resolution.
    if (!existing || commentTime >= existing.timeMs) {
      newestPerHead.set(attestedHeadSha, { attesting: { comment, attestedHeadSha }, timeMs: commentTime });
    }
  }

  return [...newestPerHead.values()]
    .filter((entry) => hasActionablePrReviewFeedback(entry.attesting.comment.body))
    .sort((a, b) => b.timeMs - a.timeMs)
    .map((entry) => entry.attesting);
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
  // going green (BLO-29711). Only a later clean review of that same earlier
  // head disposes it — see headsWithUndispositionedFinding. It clears the
  // moment Ally attests the current head, which the push that produced this
  // head already triggers, so this cannot wedge a PR that keeps being reviewed
  // on the same surface.
  const [carried] = headsWithUndispositionedFinding(comments, reviewerBotLogin);
  if (carried) {
    return {
      state: "failure",
      outcome: "carried_finding",
      reason:
        `An unresolved finding from Ally's review of ${carried.attestedHeadSha.slice(0, 7)} ` +
        "is still undispositioned; no comment attests the current head.",
      commentCreatedAt: new Date(toEpochMs(carried.comment.createdAt)).toISOString(),
      carriedFromHeadSha: carried.attestedHeadSha,
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
 * would deadlock every formally-reviewed PR. The remedy is to publish outside
 * the `review/` namespace — done for the Blockcast deployment, whose live
 * context is now `gate/ally-comment-findings`. This predicate stays as the
 * assertion point so a future config change cannot silently move the gate back
 * under `review/` (BLO-29711).
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

/**
 * Contexts to supersede with a retirement pointer, given the live context.
 *
 * The live context is excluded even if an operator also lists it as retired:
 * writing a retirement pointer over the verdict we just published would
 * replace a real `failure` with a green, which is the exact fail-open this
 * issue exists to remove.
 */
export function retiredCommentReviewGateContexts(
  retired: readonly string[] | null | undefined,
  liveContext: string,
): string[] {
  const live = liveContext.trim().toLowerCase();
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of retired ?? []) {
    const context = raw?.trim();
    if (!context) continue;
    const key = context.toLowerCase();
    if (key === live || seen.has(key)) continue;
    seen.add(key);
    result.push(context);
  }
  return result;
}

// GitHub truncates commit-status descriptions at 140 characters. The pointer to
// the live context is the entire value of a retirement write, so fall back to a
// shorter phrasing rather than letting the context name be cut in half.
const MAX_COMMIT_STATUS_DESCRIPTION = 140;

/**
 * Description for a superseded context. Deliberately carries no claim about
 * whether anything reviewed the head — that claim under a `review/`-prefixed
 * green is the defect (BLO-29711) — only a pointer to where the verdict now
 * lives. `scripts/check-comment-review-gate-census.mjs` flags a green `review/`
 * status whose description admits nothing was evaluated; this text must not
 * match that pattern.
 *
 * The blocking phrasing exists because the retirement write mirrors the live
 * state (see `supersedeRetiredContexts`). A red row whose description only said
 * "retired" would read as the retirement itself having failed.
 */
export function commentReviewGateRetirementDescription(
  liveContext: string,
  state: CommentReviewGateVerdict["state"] = "success",
): string {
  const target = liveContext.trim();
  const [full, short] =
    state === "failure"
      ? [
          `Retired. Unresolved finding stands; "${target}" carries the verdict.`,
          `Retired. Unresolved finding; see "${target}".`,
        ]
      : [
          `Retired. Comment-shaped review findings now publish to "${target}".`,
          `Retired. Findings now publish to "${target}".`,
        ];
  if (full.length <= MAX_COMMIT_STATUS_DESCRIPTION) return full;
  return short.slice(0, MAX_COMMIT_STATUS_DESCRIPTION);
}

/**
 * The status row to write over a retired context, given the live verdict.
 *
 * Split out as a pure function so the mirroring invariant is testable without
 * standing up the GitHub client: "a blocking live verdict never produces a
 * green retirement row" is the property that keeps a still-required legacy
 * context from being satisfied while the live one blocks. See
 * `supersedeRetiredContexts` for why that case is reachable.
 */
export function commentReviewGateRetirementStatus(
  liveContext: string,
  verdict: Pick<CommentReviewGateVerdict, "state">,
): { state: CommentReviewGateVerdict["state"]; description: string } {
  return {
    state: verdict.state,
    description: commentReviewGateRetirementDescription(liveContext, verdict.state),
  };
}

export type PrCommentReviewGateCheckResult =
  | {
      posted: true;
      verdict: CommentReviewGateVerdict;
      /**
       * Retired contexts still carrying their pre-retirement row because the
       * supersede write failed *while the live verdict was blocking*.
       *
       * Present only in that combination, because only that combination is
       * unsafe. A failed supersede under a clean live verdict leaves a stale
       * green next to a live green — the two agree, and nothing is bypassed. A
       * failed supersede under a *blocking* verdict leaves a stale green that
       * an operator may still have in required checks (this code cannot read
       * branch protection to find out: the App gets 403), while the live
       * context that reports the finding is not required yet. The stale row is
       * then the operative one and the PR merges with the finding unresolved —
       * BLO-29711's fail-open, reintroduced through the cleanup path.
       *
       * Surfaced rather than thrown: the live verdict *was* published, so the
       * check did its job, and failing it outright would let cleanup of a
       * superseded row break the live signal. Callers must not read a bare
       * `posted: true` as "the block is operative" when this is set.
       */
      unsupersededBlockingContexts?: string[];
    }
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

  // Both surfaces, because Ally uses whichever is available to it: a
  // `COMMENTED` pull_request_review on `/pulls/{n}/reviews`, or a plain issue
  // comment. Measured over the 25 most recent PRs in this repo, 33 of 33
  // consolidated reviews were reviews-API objects and none were issue
  // comments, so reading only the latter made this gate structurally unable to
  // observe a review (BLO-29711). Either surface failing to read leaves the
  // prior status untouched rather than publishing a verdict from half the
  // history.
  const [issueComments, prReviews] = await Promise.all([
    withBoundedRetry(
      () => githubListIssueCommentsWithTimestamps({ repoFullName: input.repoFullName, prNumber: input.prNumber }),
      (result) => result == null,
    ),
    withBoundedRetry(
      () => githubListPrReviewsWithTimestamps({ repoFullName: input.repoFullName, prNumber: input.prNumber }),
      (result) => result == null,
    ),
  ]);
  if (issueComments == null || prReviews == null) return { posted: false, reason: "fetch_failed" };

  const verdict = evaluateCommentReviewGate({
    comments: [...issueComments, ...prReviews].map((comment) => ({
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

  const unsuperseded = await supersedeRetiredContexts(input, headSha, context, config, verdict);

  // Only a blocking verdict makes a failed supersede unsafe — see
  // `unsupersededBlockingContexts`. Under a clean verdict the stale row agrees
  // with the live one, so reporting it would train operators to ignore it.
  if (verdict.state === "failure" && unsuperseded.length > 0) {
    return { posted: true, verdict, unsupersededBlockingContexts: unsuperseded };
  }

  return { posted: true, verdict };
}

/**
 * Overwrite each retired context with a pointer to the live one.
 *
 * Why this is code in the gate rather than a one-shot sweep. GitHub's Commit
 * Statuses API has create and list but no delete, so renaming the context
 * cannot retract what was already written under the old name: every head that
 * carries the old fail-open green keeps carrying it. Measured 2026-08-22, 42 of
 * 43 open PRs in Blockcast/penstock-llm-proxy-core were in exactly that state.
 * Only the credential that wrote those rows can overwrite them — the App's own
 * installation token, the one used here — so an operator script cannot do it.
 * Riding the gate's existing evaluations reaches each PR the next time it is
 * evaluated, with no sweep and no human chore.
 *
 * State mirrors the live verdict rather than being a fixed `success`. A retired
 * context is not necessarily a powerless one: an operator may still have it in
 * required checks while the new context is not yet required (BLO-26602 is
 * exactly that migration), and this code cannot see branch protection to find
 * out — the App gets 403 on that endpoint. An unconditional green would then
 * satisfy the still-required legacy check while the live context reports a
 * blocking finding, letting a PR with unresolved Critical/Important findings
 * merge: the same fail-open this issue exists to remove, reintroduced through
 * the cleanup path. Mirroring costs nothing where the context is already
 * non-required (the row is informational either way) and preserves the block
 * where it is not. It also never paints a PR red that the live context is not
 * already painting red, which was the original argument for a fixed `success`.
 *
 * Best-effort against the *live* signal by construction: the live verdict is
 * already published, and failing the check over cleanup of a superseded row
 * would let a retired context break the live one. That is not the same as
 * silent. A failure here is benign under a clean verdict and unsafe under a
 * blocking one, so the two are logged at different severities and the unsafe
 * set is returned to the caller rather than only logged (BLO-29711).
 *
 * Self-healing where it can be: the gate re-evaluates on every subsequent
 * webhook delivery for the PR, and each evaluation retries the supersede. A
 * transient write failure therefore clears on the next push or review. A
 * persistent one (403 on the retired context) does not, which is exactly the
 * case the returned set exists to surface.
 *
 * @returns retired contexts whose row could not be overwritten.
 */
async function supersedeRetiredContexts(
  input: PrCommentReviewGateCheckInput,
  headSha: string,
  liveContext: string,
  config: ReturnType<typeof loadConfig>,
  verdict: CommentReviewGateVerdict,
): Promise<string[]> {
  const retiredContexts = retiredCommentReviewGateContexts(
    config.prCommentReviewGateRetiredStatusContexts,
    liveContext,
  );
  if (retiredContexts.length === 0) return [];

  const retirement = commentReviewGateRetirementStatus(liveContext, verdict);
  const settled = await Promise.all(
    retiredContexts.map(async (retiredContext) => {
      const result = await withBoundedRetry<GitHubCommitStatusPostResult>(
        () =>
          githubPostCommitStatusDetailed({
            repoFullName: input.repoFullName,
            sha: headSha,
            context: retiredContext,
            state: retirement.state,
            description: retirement.description,
            targetUrl: input.prUrl ?? null,
          }),
        (attempt) => !attempt.ok && attempt.retryable,
      );
      if (result.ok) return null;

      const where = `"${retiredContext}" on ${input.repoFullName}@${headSha.slice(0, 7)}`;
      if (verdict.state === "failure") {
        // The live verdict blocks but the stale row does not. If the retired
        // context is still required anywhere, that row is the operative one.
        console.error(
          `[pr-comment-review-gate] UNSAFE MIGRATION STATE: could not supersede retired context ${where}: ` +
            `${result.reason}. The live context "${liveContext}" reports "${verdict.outcome}", but the stale ` +
            "row stands and still reads green. If the retired context is a required check, this PR can merge " +
            "with the finding unresolved. Remove it from required checks or restore write access (BLO-26602).",
        );
      } else {
        console.warn(
          `[pr-comment-review-gate] Could not supersede retired context ${where}: ${result.reason}. ` +
            "The stale row stands; the live verdict is clean, so nothing is bypassed.",
        );
      }
      return retiredContext;
    }),
  );

  return settled.filter((context): context is string => context !== null);
}
