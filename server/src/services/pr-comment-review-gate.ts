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
  allyClaimedReviewHead,
  hasActionablePrReviewFeedback,
  hasAllyConsolidatedReviewHeading,
  asPublishableToken,
  parseAllyVerdictBlock,
  type AllyFindingRef,
  type AllyPriorFindingDisposition,
} from "./ally-review-detection.js";
import {
  githubFetchPrHeadSha,
  githubListIssueCommentsWithTimestamps,
  githubListPrReviewsWithTimestamps,
  githubPostCheckRun,
  githubPostCommitStatusDetailed,
  githubReviewerIdentityMatches,
  type GitHubCheckRunConclusion,
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
  /**
   * The newest Ally review carries a structured verdict block this parser
   * cannot read. Distinct from every other outcome on purpose: it is neither
   * evidence of review nor evidence of a finding, and conflating it with
   * either is the misreport BLO-32695 exists to end.
   */
  | "unreadable_verdict"
  /** Nothing established a comment-shaped review of this head. Not evidence of review. */
  | "not_evaluated";

export type CommentReviewGateVerdict =
  | { state: "success"; outcome: "clean"; reason: string }
  | { state: "success"; outcome: "not_evaluated"; reason: string }
  | { state: "failure"; outcome: "blocking_finding"; reason: string; commentCreatedAt: string }
  | { state: "failure"; outcome: "unreadable_verdict"; reason: string; commentCreatedAt: string }
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

/**
 * Every candidate tied at the top of a newest-wins scan, by a lexicographic
 * numeric precedence key.
 *
 * Shared by all three scans below, which is the point of it (CTO ruling on
 * BLO-32695). Each of them used to end in `time >= best`, and each therefore
 * let array order decide the verdict whenever two comments shared a second:
 * latestAttestingAllyComment flipped clean/blocking_finding,
 * headsWithUndispositionedFinding flipped not_evaluated/carried_finding,
 * newestAllyConsolidatedReviewComments flipped clean/unreadable_verdict — all
 * three reproduced in both orders, all three fail *open*. Nothing establishes
 * that order: executeCommentReviewGateCheck concatenates two independently
 * ordered GitHub surfaces, and GitHub's created_at is second-resolution, so a
 * tie is not a corner case of the data, it is the expected collision.
 *
 * A precedence tuple is order-independent only while its final axis is a strict
 * total order, and a second-resolution timestamp is not one. So the comparison
 * is strict (`>`) and the tie is not resolved here at all: this returns the
 * whole tied set and each caller then picks the more conservative candidate —
 * `unreadable` > `finding` > `clean`, which is order-independent by
 * construction and is what AC-5 already requires. Resolving it here instead
 * would need a per-site notion of "conservative" threaded through as a
 * parameter, which is the three-comparators-that-drift shape this replaces.
 *
 * A stable sort is not an alternative: executeCommentReviewGateCheck's `.map()`
 * keeps only authorLogin/body/createdAt, so no comment id reaches these scans.
 */
function topTiedBy<T>(items: T[], key: (item: T) => number[]): T[] {
  let best: number[] | null = null;
  let tied: T[] = [];
  for (const item of items) {
    const candidate = key(item);
    const cmp = best === null ? 1 : compareKeys(candidate, best);
    if (cmp > 0) {
      best = candidate;
      tied = [item];
    } else if (cmp === 0) {
      tied.push(item);
    }
  }
  return tied;
}

function compareKeys(a: number[], b: number[]): number {
  // Equal length is the invariant, not an assumption: this loop runs to
  // `a.length`, so a shorter key with an equal prefix reports a *tie* against a
  // longer one that outranks it, while the reverse order compares `undefined`
  // and reports `-1`. Both are silent — in a helper whose whole purpose is
  // making a tie decidable.
  //
  // Exactly one shape reaches this throw: a `key` whose output length is
  // *data-dependent*, e.g. `(c) => c.attested ? [1, c.timeMs] : [c.timeMs]`.
  // That is one edit away from the live key at :412, which keeps its ternary
  // *inside* the tuple precisely so the length cannot vary with the item.
  //
  // Lengthening one call site's key does NOT reach it, and believing otherwise
  // misreads the helper: compareKeys has a single caller (:136), where both
  // arguments are outputs of the same `key` within the same topTiedBy
  // invocation. Keys from different call sites are never compared, so a longer
  // tuple changes that site's own comparisons uniformly and meets no other.
  // topTiedBy does not relate its call sites to one another (Ally, #1721 at
  // 31532b48). Unreachable today: all three keys return unconditional array
  // literals.
  if (a.length !== b.length) {
    throw new Error(`compareKeys requires equal-length keys, got ${a.length} and ${b.length}`);
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]! ? 1 : -1;
  }
  return 0;
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
  const candidates: { attesting: AttestingComment; timeMs: number }[] = [];

  for (const comment of comments) {
    if (!isAllyConsolidatedReviewComment(comment, reviewerBotLogin)) continue;
    const attestedHeadSha = extractAllyReviewedHeadSha(comment.body);
    if (!attestedHeadSha) continue;
    if (attestedHeadSha !== matchHeadSha) continue;

    const commentTime = toEpochMs(comment.createdAt);
    if (!Number.isFinite(commentTime)) continue;
    candidates.push({ attesting: { comment, attestedHeadSha }, timeMs: commentTime });
  }

  // Strictly newest wins; on an exact tie the finding wins over the clean
  // review. Two comments at the same second, one carrying a finding and one
  // clean, used to go green with the finding open whenever the finding
  // happened to come first in the array.
  const tied = topTiedBy(candidates, (candidate) => [candidate.timeMs]);
  const chosen =
    tied.find((candidate) => hasActionablePrReviewFeedback(candidate.attesting.comment.body)) ??
    tied[0];
  return chosen?.attesting ?? null;
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
  const byHead = new Map<string, { attesting: AttestingComment; timeMs: number; attested: boolean }[]>();
  const ledger: { entry: AllyPriorFindingDisposition; timeMs: number; attestedHeadSha: string }[] = [];

  for (const comment of comments) {
    if (!isAllyConsolidatedReviewComment(comment, reviewerBotLogin)) continue;
    const attestedHeadSha = extractAllyReviewedHeadSha(comment.body);
    // A review whose verdict block we cannot read still says which tree it
    // examined, and it may still *raise* a finding here — it just may never
    // retire one. Without this the whole comment was skipped at the `continue`
    // below, so a finding its prose carried vanished the moment the author
    // pushed past the reviewed head: master red that head, this branch greened
    // it (peer review of #1721 at 97b4ddd1, TrafficOpsEngineer). The unreadable
    // branch in evaluateCommentReviewGate catches it only at its own head.
    //
    // Scoped to `unreadable` deliberately. allyClaimedReviewHead is laxer than
    // the attestation parser by design, and letting it stand in for every body
    // that fails to attest would newly carry findings off ambiguous prose — a
    // change to the block-less population this row never measured. Only the
    // population the block created gets the new path.
    const claimedHeadSha =
      attestedHeadSha ??
      (parseAllyVerdictBlock(comment.body).kind === "unreadable"
        ? allyClaimedReviewHead(comment.body)
        : null);
    if (!claimedHeadSha) continue;
    const commentTime = toEpochMs(comment.createdAt);
    if (!Number.isFinite(commentTime)) continue;

    // Ledger authority requires a real attestation, which is the asymmetry this
    // whole path turns on: an unreadable verdict may carry a finding forward
    // and may not dispose of one. Retiring is the direction that loses
    // information, so it stays gated on a body we could actually parse.
    //
    // Belt and braces today rather than the mechanism: the extractor already
    // returns `[]` for an unreadable block, so this guard changes nothing on
    // its own. It is here because the loop now admits comments on a *claimed*
    // head, and without it the code would read as though a claimed head
    // conferred ledger authority — which it must not, and which would become
    // true the moment that extractor grew a prose fallback of its own.
    if (attestedHeadSha) {
      for (const entry of extractAllyPriorFindingDispositions(comment.body)) {
        ledger.push({ entry, timeMs: commentTime, attestedHeadSha });
      }
    }

    const perHead = byHead.get(claimedHeadSha);
    const candidate = {
      attesting: { comment, attestedHeadSha: claimedHeadSha },
      timeMs: commentTime,
      attested: Boolean(attestedHeadSha),
    };
    if (perHead) perHead.push(candidate);
    else byHead.set(claimedHeadSha, [candidate]);
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
        if (namesFinding(prior, headSha, entry.timeMs, finding)) {
          // Name the drift, not its payload. This set is quoted verbatim into
          // the commit-status description below, which is POSTed unscrubbed
          // (PEN-3157) — see asPublishableToken.
          verbs.add(asPublishableToken(prior.entry.disposition));
        }
      }
    }
    return [...verbs];
  };

  // Newest statement per head wins, with one precedence above recency: an
  // unreadable review may not *displace* an attested one, however much newer it
  // is, because displacing is retiring by another name. "Newest per head" means
  // the newest statement about that tree, and a verdict we could not read makes
  // no statement. Letting it win drops the older review's finding on the
  // strength of prose that merely happens not to mention one — the same
  // fail-open this branch exists to close, arriving through the fix for it
  // (peer review of #1721 at bbe6d640, TrafficOpsEngineer). Caught by the
  // pre-existing case at "leaves a finding carried from the head it names".
  // Among two unreadable reviews neither is evidence, so there is nothing to
  // lose between them.
  //
  // The remaining tie — same head, same attestation class, same second — is
  // resolved here on the *final* verdict rather than on a mid-loop proxy, which
  // is what keeps it from trading one fail-open for a quieter one. Preferring
  // the blocking body up in the loop would have handed the slot to a body that
  // isFullyDispositioned then filters straight back out, losing the tied
  // candidate that would have carried. Asking "does any tied candidate still
  // carry a finding?" is order-independent and cannot lose one.
  //
  // `countInheritedLedgerAssertion: false` keeps this enumeration answering
  // "which findings did *this head* raise?". A `still-present` entry names an
  // earlier head's finding, and that head is enumerated in its own right, so
  // counting it here would name a review whose own buckets are empty — and
  // permanently, since a 0/0 body reports no identities for any later ledger
  // entry to retire. The current-head branch deliberately does count it. That
  // asymmetry is BLO-31446's, and it survives the tied-set rewrite unchanged:
  // the option narrows what each candidate *asserts*, the tie-break decides
  // *which* candidates are eligible to assert it, and neither reads the other.
  const carried: { attesting: AttestingComment; timeMs: number }[] = [];
  for (const candidates of byHead.values()) {
    const tied = topTiedBy(candidates, (candidate) => [candidate.attested ? 1 : 0, candidate.timeMs]);
    const blocking = tied.find(
      (entry) =>
        hasActionablePrReviewFeedback(entry.attesting.comment.body, undefined, {
          countInheritedLedgerAssertion: false,
        }) && !isFullyDispositioned(entry),
    );
    if (blocking) carried.push(blocking);
  }

  // Cross-head, and the last `timeMs`-only comparison left. The verdict does
  // not turn on it — every entry here already carries a finding — but
  // evaluateCommentReviewGate takes `[carried]` and puts that head's short SHA
  // in the commit-status text, so two heads carrying at the same second named
  // a different one on each run. The head is the final axis because it is a
  // strict total order and a second-resolution timestamp is not.
  return carried
    .sort(
      (a, b) =>
        b.timeMs - a.timeMs ||
        a.attesting.attestedHeadSha.localeCompare(b.attesting.attestedHeadSha),
    )
    .map((entry) => ({ ...entry.attesting, unrecognizedVerbs: unrecognizedVerbsBlocking(entry) }));
}

/**
 * The newest Ally consolidated-review comments, whatever they attest — the
 * whole set tied at that second, not a winner among them.
 *
 * Deliberately not filtered by attestation: the point is to reach a review
 * whose head could not be established, which is precisely the case
 * latestAttestingAllyComment skips.
 *
 * The tie is returned rather than resolved because the only caller's predicate
 * is strictly wider than the one this function could apply: it wants an
 * unreadable review that is *also* in scope for the head being evaluated, and
 * scope is not known here. Picking on the narrower predicate alone let `find`
 * hand the slot to an unreadable review naming some other tree, which the
 * caller then scopes out — so the in-scope unreadable review was never
 * examined and the gate went green off a candidate nobody consulted (Ally,
 * peer review of #1721 at 9fd4b499; the same shape as the mid-loop proxy at
 * headsWithUndispositionedFinding, and it fails open the same way). A
 * tie-break is order-independent only when its predicate is the caller's whole
 * predicate.
 */
function newestAllyConsolidatedReviewComments(
  comments: CommentReviewGateComment[],
  reviewerBotLogin: string,
): CommentReviewGateComment[] {
  const candidates: { comment: CommentReviewGateComment; timeMs: number }[] = [];
  for (const comment of comments) {
    if (!isAllyConsolidatedReviewComment(comment, reviewerBotLogin)) continue;
    const commentTime = toEpochMs(comment.createdAt);
    if (!Number.isFinite(commentTime)) continue;
    candidates.push({ comment, timeMs: commentTime });
  }
  return topTiedBy(candidates, (candidate) => [candidate.timeMs]).map(
    (candidate) => candidate.comment,
  );
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

  // Checked before anything else, scoped to the newest review, and scoped to
  // this head.
  //
  // Scoped to the newest review, because an unreadable block anywhere in
  // history would wedge the PR permanently with no route out — the same
  // unretirable trap BLO-31446 and BLO-31947 document.
  //
  // Checked first, because the alternative is silence: an unreadable block
  // attests no head, so without this branch the newest review is invisible and
  // an *older* review of the same head stays authoritative. That is not
  // hypothetical — it is exactly how paperclip#1675 reported a finding Ally
  // had withdrawn. The 15:41:42Z clean review failed to attest, so the
  // 03:46:19Z review of the same head kept its `Important Issues (1)`, and the
  // gate published `blocking_finding` against a superseded verdict.
  //
  // Scoped to this head, because "newest" is not "at this head" and the
  // difference is a real red on a tree nobody reviewed.
  // newestAllyConsolidatedReviewComments has no head filter, so unscoped this
  // branch lets a malformed block from three pushes ago decide the current
  // head — where the same PR with no comments at all is `not_evaluated`, i.e.
  // green. A stale broken block must not be worse for an author than no review
  // (found in peer review of #1721 at 11a52e9a). It matters most on the
  // designed upgrade path: SUPPORTED_ALLY_VERDICT_VERSION is bumped by a
  // server rollout, but the producer is a prompt that takes effect the moment
  // it merges, so between those two moments an unscoped branch reds every open
  // PR at once — including PRs whose current head was never reviewed.
  //
  // The scoping test is asymmetric and fails closed, which is what keeps AC-5:
  // the branch is skipped only when the review *positively* names some other
  // tree. allyClaimedReviewHead returning null means "cannot tell which head
  // this examined", and that is an ambiguity, not an exemption — a review of
  // this head whose verdict we could not read is precisely the case that must
  // not resolve to success. Only a head we can read, and that is not this one,
  // makes the unreadable verdict somebody else's problem.
  // Applied as one predicate over the whole tied set, because scope and
  // readability are both parts of the question and splitting them across the
  // helper and here is what let a tie go green (see
  // newestAllyConsolidatedReviewComments). Among reviews we cannot order,
  // "does any of them make this claim?" is order-independent.
  //
  // The verdict is settled by that existential, but the *cause* is not: every
  // tied candidate yields the same {state, outcome} while `block.reason`
  // differs between them, and that string becomes the commit-status
  // description and the check-run summary. Returning on the first match let
  // array order name a different cause on each run. So the scan is exhaustive
  // and the reason is the final axis — lexicographically smallest, mirroring
  // the cross-head tie-break at :429, which is a strict total order where a
  // second-resolution timestamp is not. commentCreatedAt travels with the
  // chosen candidate so the two can never describe different comments
  // (Ally, #1721 at 31532b48).
  let unreadable: { reason: string; commentCreatedAt: string } | null = null;
  for (const review of newestAllyConsolidatedReviewComments(comments, reviewerBotLogin)) {
    const claimedHead = allyClaimedReviewHead(review.body);
    if (claimedHead !== null && claimedHead !== normalizedHead) continue;
    const block = parseAllyVerdictBlock(review.body);
    if (block.kind !== "unreadable") continue;
    if (unreadable === null || block.reason.localeCompare(unreadable.reason) < 0) {
      unreadable = {
        reason: block.reason,
        commentCreatedAt: new Date(toEpochMs(review.createdAt)).toISOString(),
      };
    }
  }
  if (unreadable) {
    return {
      state: "failure",
      outcome: "unreadable_verdict",
      reason: `Ally's newest review carries an unreadable verdict block: ${unreadable.reason}.`,
      commentCreatedAt: unreadable.commentCreatedAt,
    };
  }

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
    // Name the source that decided this, because "clean" from a counted
    // structured block and "clean" from the prose fallback are different
    // claims with different failure modes, and the whole point of BLO-32695
    // is being able to tell which one you are looking at. Without this the
    // gate description is identical either way, so a silent regression back
    // onto the prose path — the exact thing this change retires — would be
    // invisible on the PR.
    // Both phrasings are kept inside MAX_COMMIT_STATUS_DESCRIPTION. The writer
    // in github-app-auth.ts slices at 140 before the POST, so an overlong
    // description is never rejected — it is silently cut, and what it cuts is
    // the tail, which is where the source attribution lives. Pinned by test.
    const source =
      parseAllyVerdictBlock(forHead.comment.body).kind === "ok"
        ? "its structured ally-verdict block"
        : "prose fallback (no ally-verdict block)";
    return {
      state: "success",
      outcome: "clean",
      reason: `Ally's most recent consolidated-review comment for this head reports no unresolved findings, per ${source}.`,
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
    //
    // PEN-3157 asked whether this republishes model-authored text to a public
    // commit status without a scrub, since the verb is lifted verbatim out of
    // an Ally review comment body. It does not, and the reason is worth having
    // in writing because the interpolation looks unbounded here: the verb is
    // unbounded in LENGTH but not in ALPHABET. It reaches this line through the
    // single capture group `([a-z][a-z-]*)` in
    // `PRIOR_FINDING_DISPOSITION_PATTERN` (ally-review-detection.ts), the only
    // writer of `disposition`, so it is lowercase letters and hyphens and
    // nothing else. That admits no credential this codebase is exposed to — an
    // AWS key id, a bearer token, a JWT and a PEM all carry uppercase, digits,
    // or punctuation outside that class. See the invariant test in
    // `github-write-egress-scrub.test.ts`, which fails if the class widens.
    // Defence in depth still applies: `githubPostCommitStatusDetailed` scrubs
    // every description on the way out, so widening the class would be caught
    // by the boundary even if that test were deleted.
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
 * Check-run conclusion for a verdict.
 *
 * This is the whole point of publishing a check-run alongside the commit
 * status (BLO-33657). The status surface collapses `clean` and `not_evaluated`
 * into one green `success`, because a legacy status has only four states and
 * none of the other three is both honest and non-blocking: `pending` deadlocks
 * every formally-reviewed PR (the constraint BLO-29711 pinned), and
 * `failure`/`error` assert a finding that does not exist.
 *
 * `neutral` is the state that was missing. It renders distinctly from green in
 * the UI and in `check-runs` API reads, and it does not block merge — so a
 * reader can tell "reviewed and clean" from "nothing reviewed this head" by the
 * conclusion alone, without parsing the human-readable description.
 */
export function commentReviewGateCheckConclusion(
  verdict: Pick<CommentReviewGateVerdict, "state" | "outcome">,
): GitHubCheckRunConclusion {
  if (verdict.state === "failure") return "failure";
  return verdict.outcome === "clean" ? "success" : "neutral";
}

/** Short check-run title, so the conclusion is legible without opening it. */
export function commentReviewGateCheckTitle(
  verdict: Pick<CommentReviewGateVerdict, "state" | "outcome">,
): string {
  switch (verdict.outcome) {
    case "clean":
      return "Reviewed at this head — no unresolved findings";
    case "blocking_finding":
      return "Unresolved finding at this head";
    case "carried_finding":
      return "Unresolved finding carried from an earlier head";
    // Deliberately does not say "finding": this outcome is neither evidence of
    // review nor evidence of a finding, and the title is the surface a reader
    // sees before opening the check. Calling it a finding here would re-commit
    // the misreport BLO-32695 exists to end, on the one line most likely to be
    // read in isolation.
    case "unreadable_verdict":
      return "Verdict block unreadable — no finding asserted";
    case "not_evaluated":
      return "Not evaluated — no comment-shaped review attests this head";
  }
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
 *
 * Note this only ever described the *status* surface. Renaming stopped the
 * misreading for a reader who inspects the namespace, not for one who reads the
 * colour; the check-run's `neutral` conclusion is what addresses the colour
 * (BLO-33657).
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
  const renderShort = (name: string) =>
    state === "failure"
      ? `Retired. Unresolved finding; see "${name}".`
      : `Retired. Findings now publish to "${name}".`;
  const full =
    state === "failure"
      ? `Retired. Unresolved finding stands; "${target}" carries the verdict.`
      : `Retired. Comment-shaped review findings now publish to "${target}".`;
  if (full.length <= MAX_COMMIT_STATUS_DESCRIPTION) return full;
  const short = renderShort(target);
  if (short.length <= MAX_COMMIT_STATUS_DESCRIPTION) return short;
  // Both phrasings overflow, so the context name itself is what is long.
  // Elide the NAME rather than slicing the rendered sentence: a blind slice
  // cuts the name mid-token and drops the closing quote, which is exactly the
  // "cut in half" outcome the fallback exists to avoid. Unreachable with
  // today's names; pinned by test so it stays true if a name grows.
  const budget = MAX_COMMIT_STATUS_DESCRIPTION - renderShort("").length - 1;
  if (budget <= 0) return short.slice(0, MAX_COMMIT_STATUS_DESCRIPTION);
  return renderShort(`${target.slice(0, budget)}…`);
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
      reason: "not_configured" | "fetch_failed" | "post_failed" | "retirement_failed";
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

    await publishCheckRunMirror(input, headSha, context, verdict);

    const retirementFailures = await supersedeRetiredContexts(input, headSha, context, config, verdict);
    if (retirementFailures.length > 0) {
      // NOT "post_failed": the live status published successfully at line 643
      // above, and only the retired-context cleanup did not. Reporting this as
      // a post failure states the opposite of what happened for the field that
      // matters most. `retirementDeliveries` used to be the sole discriminator
      // between the two, which is easy to get wrong from outside — a distinct
      // reason makes both states self-describing.
      return {
        posted: false,
        reason: "retirement_failed",
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
 * Publish the same verdict as a check-run, alongside the commit status.
 *
 * Dual-emit, not a replacement. The status context may still be a required
 * check somewhere, and this code cannot read branch protection to find out —
 * the App gets 403 on that endpoint — so dropping it could strand every PR in a
 * repo that requires it. The status keeps its existing states; the check-run
 * adds the `neutral` conclusion that the status surface cannot express.
 *
 * Best-effort, and deliberately so: the verdict is already published on the
 * status surface by the time this runs, and the added value here is legibility,
 * not enforcement. Failing the whole check because the check-run write was
 * refused would turn a *better* signal into an outage of the working one — most
 * likely on exactly the deployments whose installation lacks `checks: write`,
 * since that permission is independent of `statuses: write`. Logged once per
 * repo so a missing grant is diagnosable without a log flood.
 */
const checkRunWriteWarnings = new Set<string>();

async function publishCheckRunMirror(
  input: PrCommentReviewGateCheckInput,
  headSha: string,
  context: string,
  verdict: CommentReviewGateVerdict,
): Promise<void> {
  let reason: string;
  try {
    const result = await withBoundedRetry<GitHubCommitStatusPostResult>(
      () =>
        githubPostCheckRun({
          repoFullName: input.repoFullName,
          sha: headSha,
          name: context,
          conclusion: commentReviewGateCheckConclusion(verdict),
          title: commentReviewGateCheckTitle(verdict),
          summary: verdict.reason,
          detailsUrl: input.prUrl ?? null,
        }),
      (attempt) => !attempt.ok && attempt.retryable,
    );
    if (result.ok) return;
    reason = result.reason;
  } catch (error) {
    // "Best-effort" has to mean it too. `githubPostCheckRun` returns a
    // classified result rather than throwing, but it can still throw for
    // reasons outside its own error handling — an unmocked export under test,
    // a module that failed to load. Letting that escape would reject the whole
    // publish and lose the commit status that was already written, which is the
    // exact "a better signal takes out the working one" outcome this function
    // is structured to avoid.
    reason = error instanceof Error ? error.message : String(error);
  }
  if (checkRunWriteWarnings.has(input.repoFullName)) return;
  checkRunWriteWarnings.add(input.repoFullName);
  console.warn(
    `[pr-comment-review-gate] Could not publish the "${context}" check-run on ${input.repoFullName}: ` +
      `${reason}. The commit status is still authoritative, but "not evaluated" and ` +
      `"reviewed clean" both render green there — the check-run is what separates them. ` +
      "A 403 here means the installation is missing `checks: write` (BLO-33657).",
  );
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
