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
import type { Db } from "@paperclipai/db";
import { withGithubStatusDeliveryLock } from "./github-status-delivery-outbox.js";
import {
  extractAllyPriorFindingDispositions,
  extractAllyReportedFindingRefs,
  extractAllyReviewedHeadSha,
  hasActionablePrReviewFeedback,
  hasAllyConsolidatedReviewHeading,
  type AllyFindingRef,
  type AllyPriorFindingDisposition,
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

// Characters of the unrecognized-verb list a carried-finding reason may spend.
// Sized so the message stays inside GitHub's 140-character commit-status cap
// with the head and the explanatory phrase intact, since those are what make
// the red actionable.
const UNRECOGNIZED_VERB_BUDGET = 48;

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

interface CarriedFinding extends AttestingComment {
  /**
   * Ledger verbs that named a still-unretired finding on this head but that
   * the parser does not recognize. Empty in the ordinary case; non-empty means
   * the red is explainable by vocabulary drift rather than by an open finding.
   */
  unrecognizedVerbs: string[];
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
 * Disposition is tracked per attested head, not by global comment recency.
 * Two things dispose a finding raised against head H:
 *
 *   - A later clean attestation of H itself: Ally re-examined that exact tree
 *     and found nothing.
 *   - A later review retiring *every* finding H raised, by name, under "Prior
 *     Findings Dispositioned": Ally asserting directly that it re-checked those
 *     specific findings and they are gone. Retiring only some of them leaves H
 *     carried — one `fixed` entry must not clear a review that reported several
 *     findings.
 *
 * A clean attestation of some *other* head disposes nothing by itself, because
 * nothing in that alone establishes that the other head contains the fix —
 * comment chronology is not commit ancestry, and reviews can land out of order
 * relative to pushes. The ledger is what supplies that missing link, and
 * reading only the first rule wedged PRs whose finding Ally had already marked
 * resolved: on Blockcast/libmmt#362 the review of c9a1765 recorded
 * `prior:731ced5 critical 1 — fixed`, and this gate still reported 731ced5
 * undispositioned once the head moved on again.
 *
 * Reading only the globally newest attestation instead let A(blocking) ->
 * B(clean) -> C(unattested) drop A's finding silently (BLO-29711, Ally review
 * of #1464).
 */
function headsWithUndispositionedFinding(
  comments: CommentReviewGateComment[],
  reviewerBotLogin: string,
): CarriedFinding[] {
  const newestPerHead = new Map<string, { attesting: AttestingComment; timeMs: number }>();
  const ledger: { entry: AllyPriorFindingDisposition; timeMs: number; attestedHeadSha: string }[] = [];

  for (const comment of comments) {
    if (!isAllyConsolidatedReviewComment(comment, reviewerBotLogin)) continue;
    const attestedHeadSha = extractAllyReviewedHeadSha(comment.body);
    if (!attestedHeadSha) continue;
    const commentTime = toEpochMs(comment.createdAt);
    if (!Number.isFinite(commentTime)) continue;

    for (const entry of extractAllyPriorFindingDispositions(comment.body)) {
      ledger.push({ entry, timeMs: commentTime, attestedHeadSha });
    }

    const existing = newestPerHead.get(attestedHeadSha);
    // Ties prefer the later item, matching latestAttestingAllyComment: the
    // comment endpoint is chronological but its timestamps are second-resolution.
    if (!existing || commentTime >= existing.timeMs) {
      newestPerHead.set(attestedHeadSha, { attesting: { comment, attestedHeadSha }, timeMs: commentTime });
    }
  }

  // A ledger entry speaks only to findings that already existed when it was
  // written, so it must be at least as new as the attestation it names, and it
  // must come from a review of a different head — a review cannot disposition
  // its own finding. That second condition is what makes `>=` safe against the
  // second-resolution timestamps.
  //
  // Shared by the retirement check and the unrecognized-verb diagnostic so the
  // explanation can only ever name an entry that would otherwise have retired
  // the finding.
  const namesFinding = (
    prior: { entry: AllyPriorFindingDisposition; timeMs: number; attestedHeadSha: string },
    headSha: string,
    attestedAtMs: number,
    finding: AllyFindingRef,
  ): boolean =>
    prior.attestedHeadSha !== headSha &&
    prior.timeMs >= attestedAtMs &&
    headSha.startsWith(prior.entry.shortSha) &&
    prior.entry.severity === finding.severity &&
    prior.entry.index === finding.index;

  const isRetired = (headSha: string, attestedAtMs: number, finding: AllyFindingRef): boolean =>
    ledger.some(
      (prior) => prior.entry.kind === "retires" && namesFinding(prior, headSha, attestedAtMs, finding),
    );

  // Ally saying a finding still stands is an explicit answer, not a gap in this
  // parser's vocabulary. When both dispositions name one finding, the known one
  // is the true reason it is still blocking.
  const isExplicitlyBlocked = (
    headSha: string,
    attestedAtMs: number,
    finding: AllyFindingRef,
  ): boolean =>
    ledger.some(
      (prior) => prior.entry.kind === "blocks" && namesFinding(prior, headSha, attestedAtMs, finding),
    );

  // A head is dispositioned only once *every* finding it raised has been
  // retired by name. Matching on the head alone would let one `fixed` entry
  // clear a review that reported several findings, dropping the ones the ledger
  // never mentioned. `null` means the blocking feedback came from prose or an
  // uncounted heading, so no finding identities exist to match against and the
  // head stays carried.
  const isFullyDispositioned = (entry: { attesting: AttestingComment; timeMs: number }): boolean => {
    const reported = extractAllyReportedFindingRefs(entry.attesting.comment.body);
    if (!reported || reported.length === 0) return false;
    return reported.every((finding) =>
      isRetired(entry.attesting.attestedHeadSha, entry.timeMs, finding),
    );
  };

  // Verbs that named a still-unretired finding on this head but that this
  // parser does not know. Failing closed on those is correct, but leaving the
  // red unexplained is not: without this the status says a finding is
  // undispositioned while Ally's ledger visibly dispositions it, and nothing
  // tells a reader that the verb is the reason. A finding Ally has explicitly
  // marked `still-present` is excluded — reporting drift there would name the
  // wrong cause, which is worse than saying nothing.
  const unrecognizedVerbsBlocking = (entry: {
    attesting: AttestingComment;
    timeMs: number;
  }): string[] => {
    const headSha = entry.attesting.attestedHeadSha;
    const reported = extractAllyReportedFindingRefs(entry.attesting.comment.body);
    if (!reported) return [];
    const verbs = new Set<string>();
    for (const finding of reported) {
      if (isRetired(headSha, entry.timeMs, finding)) continue;
      if (isExplicitlyBlocked(headSha, entry.timeMs, finding)) continue;
      for (const prior of ledger) {
        if (prior.entry.kind !== "unrecognized") continue;
        if (namesFinding(prior, headSha, entry.timeMs, finding)) verbs.add(prior.entry.disposition);
      }
    }
    return [...verbs];
  };

  return [...newestPerHead.values()]
    .filter(
      (entry) => hasActionablePrReviewFeedback(entry.attesting.comment.body) && !isFullyDispositioned(entry),
    )
    .sort((a, b) => b.timeMs - a.timeMs)
    .map((entry) => ({ ...entry.attesting, unrecognizedVerbs: unrecognizedVerbsBlocking(entry) }));
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
  // going green (BLO-29711). It is disposed by a later clean review of that
  // same earlier head, or by a later review that names it as resolved in its
  // prior-findings ledger — see headsWithUndispositionedFinding. It also clears
  // the moment Ally attests the current head. Note that none of those routes
  // exists while the reviewer itself is failing to run, which is the state that
  // strands a PR here.
  const [carried] = headsWithUndispositionedFinding(comments, reviewerBotLogin);
  if (carried) {
    const shortHead = carried.attestedHeadSha.slice(0, 7);
    // GitHub caps a commit-status description at 140 characters, so this is a
    // replacement message rather than a suffix on the ordinary one: appending
    // would push the part that explains the red past the cap and lose exactly
    // the detail this branch exists to surface. The verb list is budgeted for
    // the same reason — the regex accepts an arbitrarily long verb, and the
    // head plus the "unrecognized ledger verb" phrase must survive intact.
    const verbList = carried.unrecognizedVerbs
      .map((verb) => `"${verb}"`)
      .join(", ")
      .slice(0, UNRECOGNIZED_VERB_BUDGET);
    const reason = carried.unrecognizedVerbs.length
      ? `A finding from Ally's review of ${shortHead} is undispositioned: unrecognized ledger ` +
        `${carried.unrecognizedVerbs.length === 1 ? "verb" : "verbs"} ${verbList}.`
      : `An unresolved finding from Ally's review of ${shortHead} ` +
        "is still undispositioned; no comment attests the current head.";
    return {
      state: "failure",
      outcome: "carried_finding",
      reason,
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
  | { posted: true; verdict: CommentReviewGateVerdict }
  | {
      posted: false;
      reason: "not_configured" | "fetch_failed" | "post_failed";
      postFailure?: string;
      retirementDeliveries?: Array<{
        sha: string;
        context: string;
        state: CommentReviewGateVerdict["state"];
        description: string;
        targetUrl: string | null;
      }>;
    };

export interface PrCommentReviewGateCheckInput {
  repoFullName: string;
  prNumber: number;
  headSha?: string | null;
  prUrl?: string | null;
  // Required, not optional. This handle is the only cross-process boundary
  // serializing evaluations of one head: the in-process `gateEvaluationChains`
  // map below does not span API pods. When it was optional, any caller that
  // forgot it silently got the unsynchronized path and re-opened the
  // out-of-order-verdict race. Test injection passes a stub.
  db: Db;
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

  // Fail closed rather than evaluating unsynchronized. `db` is required by the
  // type, but this module is reachable from JS callers and from tests that are
  // excluded from `tsc`, so the invariant needs a runtime edge too. Publishing
  // a verdict without the cross-process lock is the out-of-order-write bug this
  // gate already had once; refusing to publish is the recoverable direction,
  // because the next webhook for this head re-evaluates.
  if (!input.db) {
    throw new Error(
      "runPrCommentReviewGateCheck requires `db`: it is the cross-process lock that keeps a " +
        "stale verdict from overwriting a newer one. Pass the request's database handle.",
    );
  }

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

  const publish = async (): Promise<PrCommentReviewGateCheckResult> => {
    // Both surfaces, because Ally uses whichever is available to it: a
    // `COMMENTED` pull_request_review on `/pulls/{n}/reviews`, or a plain issue
    // comment. Read and evaluate them inside the shared lock. Otherwise two
    // API pods can compute against different snapshots and publish an older
    // verdict after a newer one (BLO-29711).
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

    const retirementFailures = await supersedeRetiredContexts(input, headSha, context, config, verdict);
    if (retirementFailures.length > 0) {
      return {
        posted: false,
        reason: "post_failed",
        postFailure: retirementFailures.map((failure) => `${failure.context}: ${failure.reason}`).join(", "),
        retirementDeliveries: retirementFailures.map((failure) => ({
          sha: headSha,
          context: failure.context,
          state: failure.state,
          description: failure.description,
          targetUrl: input.prUrl ?? null,
        })),
      };
    }

    return { posted: true, verdict };
  };

  // Serialize evidence reads, verdict computation, and all status writes with
  // forced retries. The transaction-scoped lock is the cross-process boundary,
  // and it is unconditional: `db` is required precisely so there is no
  // unsynchronized fall-through for a caller to reach by omission.
  return withGithubStatusDeliveryLock(input.db, `${input.repoFullName}#${headSha}`, publish);
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
 * Best-effort by construction: the live verdict is already published, and
 * failing the check over cleanup of a superseded row would let a retired
 * context break the live one.
 */
async function supersedeRetiredContexts(
  input: PrCommentReviewGateCheckInput,
  headSha: string,
  liveContext: string,
  config: ReturnType<typeof loadConfig>,
  verdict: CommentReviewGateVerdict,
): Promise<Array<{ context: string; reason: string; state: CommentReviewGateVerdict["state"]; description: string }>> {
  const retiredContexts = retiredCommentReviewGateContexts(
    config.prCommentReviewGateRetiredStatusContexts,
    liveContext,
  );
  if (retiredContexts.length === 0) return [];

  const retirement = commentReviewGateRetirementStatus(liveContext, verdict);
  const failures = await Promise.all(
    retiredContexts.map(async (retiredContext) => {
      const post = () =>
        withBoundedRetry<GitHubCommitStatusPostResult>(
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
      const result = await post();
      if (!result.ok) {
        console.warn(
          `[pr-comment-review-gate] Could not supersede retired context "${retiredContext}" on ` +
            `${input.repoFullName}@${headSha.slice(0, 7)}: ${result.reason}. Queuing a durable retry.`,
        );
        return {
          context: retiredContext,
          reason: result.reason,
          state: retirement.state,
          description: retirement.description,
        };
      }
      return null;
    }),
  );
  return failures.filter((failure): failure is NonNullable<typeof failure> => failure !== null);
}
