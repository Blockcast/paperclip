/**
 * Re-drive `gate/ally-comment-findings` when GitHub never delivered the review
 * event (BLO-39871).
 *
 * Three distinct ways this gate goes stale, and only this module covers the
 * third:
 *
 *   1. **Missing branch** — the evaluator never ran on `pull_request_review`
 *      at all. Fixed and deployed (BLO-29853).
 *   2. **Lost evaluation** — the delivery arrives, the evaluation runs, the
 *      status write fails and is never retried. Fixed by the durable outbox in
 *      #2061 (BLO-36819).
 *   3. **Lost trigger** — *the delivery never arrives*. Measured on
 *      `Blockcast/trafficcontrol#2022` @ `0ad8773c`: the gate went `failure` at
 *      06:47:35Z, Ally submitted an APPROVED review at that exact head at
 *      07:29:34Z, and no `pull_request_review` event was ever delivered for it
 *      (repo hook deliveries are contiguous across the window and contain none;
 *      no handler log exists). Nothing recovers it: #2061's backstop is enqueued
 *      *inside* the webhook handler, so no webhook means no backstop row, and
 *      the `issue_comment` branch requires a consolidated-review heading that a
 *      `<!-- paperclip:review-request -->` marker does not carry. The red stood
 *      until a human hand-verified Ally 0/0 and overrode it.
 *
 * ## Why a sweep and not a new trigger
 *
 * Letting marker comments return a gate trigger gives a *manual* re-drive —
 * someone still has to notice the stale red, which is the part that failed. It
 * also routes recovery through the one branch #2061 deliberately leaves
 * unbackstopped (an `issue_comment` payload carries no head sha, so taking one
 * would mean an API read before the webhook ack). This sweep recovers with no
 * human in the loop, and its own re-drive IS covered by #2061's backstop once
 * that lands: it calls the same `runPrCommentReviewGateCheck`, whose status
 * writes go through the same outbox as the webhook path.
 *
 * ## Why it is self-cancelling
 *
 * A PR is a candidate only while its gate status at the head is older than the
 * reviewer's latest review, or absent entirely. Re-driving writes a status whose
 * `created_at` postdates that review, so the next sweep skips it. A PR whose
 * status already postdates its latest review is never probed past one cheap
 * status read, and a PR with no reviewer review at all costs nothing.
 *
 * ## No fail-open
 *
 * This module decides *when* to ask, never *what* the answer is. The verdict
 * still comes from `runPrCommentReviewGateCheck`, which re-lists both surfaces
 * live and filters by reviewer identity. Nothing here is read from a webhook
 * payload body or author, because there is no payload — that is the whole point.
 * The head sha is deliberately NOT passed through: the gate resolves the live
 * head itself, so a head that moved since enumeration is evaluated as it is now
 * rather than as the sweep remembers it.
 */

import type { Db } from "@paperclipai/db";
import { loadConfig } from "../config.js";
import { githubGetLatestCommitStatusForContext, githubReviewerIdentityMatches } from "./github-app-auth.js";
import { runPrCommentReviewGateCheck } from "./pr-comment-review-gate.js";
import { logger as defaultLogger } from "../middleware/logger.js";

/**
 * Re-drives attempted per repo per sweep.
 *
 * ponytail: a flat cap, not a backoff. It bounds the one branch that spends API
 * budget, which matters because the condition that strands a gate write —
 * installation rate-limit exhaustion — is also the condition under which a
 * re-drive is most likely to fail and be retried next sweep. If re-drives
 * routinely hit this cap, give each PR a persisted attempt counter rather than
 * raising it.
 */
export const DEFAULT_MAX_GATE_REDRIVES_PER_REPO = 20;

export type GateRedriveCandidate = {
  prNumber: number;
  /** Head sha from the open-PR list payload. `null` disqualifies: nothing to probe. */
  headSha: string | null;
  prUrl: string | null;
  /** False means the reviews probe failed — absence of reviews is then unproven. */
  reviewsReadable: boolean;
  reviews: Array<{ authorLogin: string | null; submittedAt: string }>;
};

export type GateRedriveResult = {
  /** Candidates offered to this pass. */
  considered: number;
  /** Candidates that cost a commit-status read. */
  probed: number;
  /** Gate evaluations actually driven. */
  redriven: number;
  /** Re-drives that threw or reported a non-post. */
  failed: number;
  /** True when {@link DEFAULT_MAX_GATE_REDRIVES_PER_REPO} stopped the pass early. */
  capped: boolean;
};

type Logger = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };

const EMPTY_RESULT: GateRedriveResult = {
  considered: 0,
  probed: 0,
  redriven: 0,
  failed: 0,
  capped: false,
};

/**
 * Timestamp of the reviewer's most recent review, or `null` when they have not
 * reviewed.
 *
 * Deliberately no `state` filter. The question this answers is "could the
 * evaluator now compute something different?", and every submitted state can
 * change the verdict — including `DISMISSED`, which the evaluator's own reader
 * drops, so dismissing a blocking review changes the answer exactly as much as
 * submitting a clean one does. The same reasoning the `pull_request_review`
 * webhook branch gives for accepting all three mutating actions.
 */
export function latestReviewerReviewAt(
  reviews: Array<{ authorLogin: string | null; submittedAt: string }>,
  reviewerBotLogin: string,
): string | null {
  let latest: number | null = null;
  let latestRaw: string | null = null;
  for (const review of reviews) {
    if (!githubReviewerIdentityMatches(review.authorLogin ?? "", reviewerBotLogin)) continue;
    const parsed = Date.parse(review.submittedAt);
    if (!Number.isFinite(parsed)) continue;
    if (latest === null || parsed > latest) {
      latest = parsed;
      latestRaw = review.submittedAt;
    }
  }
  return latestRaw;
}

/**
 * Is the published gate status older than the review that should have re-driven
 * it?
 *
 * An absent status counts as stale: that is the shape a lost *first* delivery
 * leaves behind, and it converges after one re-drive because the gate always
 * publishes. An unparseable status timestamp is treated the same way rather than
 * as "current" — the failure direction has to be "ask again", never "assume the
 * red was deliberate".
 */
export function gateStatusIsStale(statusCreatedAt: string | null, latestReviewAt: string): boolean {
  const reviewTime = Date.parse(latestReviewAt);
  if (!Number.isFinite(reviewTime)) return false;
  if (statusCreatedAt === null) return true;
  const statusTime = Date.parse(statusCreatedAt);
  if (!Number.isFinite(statusTime)) return true;
  return statusTime < reviewTime;
}

/**
 * One re-drive pass over a repo's open PRs.
 *
 * Takes candidates the caller has already enumerated rather than enumerating
 * again: the open-PR list and the per-PR reviews are the expensive part, and
 * `pr-review-state-reconciler` has both in hand by the time it calls this.
 */
export async function redriveStaleCommentReviewGates(input: {
  db: Db;
  repoFullName: string;
  candidates: GateRedriveCandidate[];
  reviewerBotLogin?: string;
  statusContext?: string;
  maxRedrives?: number;
  logger?: Logger;
  deps?: {
    readStatus?: typeof githubGetLatestCommitStatusForContext;
    runGateCheck?: typeof runPrCommentReviewGateCheck;
  };
}): Promise<GateRedriveResult> {
  const config = loadConfig();
  const statusContext = (input.statusContext ?? config.prCommentReviewGateStatusContext).trim();
  // A deployment that has not opted into the gate must not pay a status read per
  // PR per sweep for a context nobody publishes.
  if (!statusContext) return { ...EMPTY_RESULT };

  const reviewerBotLogin = (input.reviewerBotLogin ?? config.prReviewerBotLogin).trim();
  if (!reviewerBotLogin) return { ...EMPTY_RESULT };

  const log = input.logger ?? defaultLogger;
  const readStatus = input.deps?.readStatus ?? githubGetLatestCommitStatusForContext;
  const runGateCheck = input.deps?.runGateCheck ?? runPrCommentReviewGateCheck;
  const maxRedrives = input.maxRedrives ?? DEFAULT_MAX_GATE_REDRIVES_PER_REPO;

  const result: GateRedriveResult = { ...EMPTY_RESULT, considered: input.candidates.length };

  for (const candidate of input.candidates) {
    // An unreadable reviews probe is not "no reviews". Skipping is the only safe
    // reading: re-driving every PR on an unreadable repo is an evaluation storm,
    // and the next sweep re-reads.
    if (!candidate.reviewsReadable || !candidate.headSha) continue;
    const latestReviewAt = latestReviewerReviewAt(candidate.reviews, reviewerBotLogin);
    if (!latestReviewAt) continue;

    if (result.redriven >= maxRedrives) {
      result.capped = true;
      break;
    }

    result.probed += 1;
    const status = await readStatus({
      repoFullName: input.repoFullName,
      sha: candidate.headSha,
      context: statusContext,
    });
    // Fail closed on an unreadable status for the same reason as above: the
    // commonest cause is an exhausted installation budget, and re-driving blind
    // under that condition spends the budget that would have recovered it.
    if (!status.ok) continue;
    if (!gateStatusIsStale(status.status?.createdAt ?? null, latestReviewAt)) continue;

    try {
      const check = await runGateCheck({
        repoFullName: input.repoFullName,
        prNumber: candidate.prNumber,
        prUrl: candidate.prUrl,
        db: input.db,
      });
      if (check.posted) {
        result.redriven += 1;
        log.info(
          {
            repoFullName: input.repoFullName,
            prNumber: candidate.prNumber,
            headSha: candidate.headSha,
            staleStatusAt: status.status?.createdAt ?? null,
            latestReviewAt,
            state: check.verdict.state,
          },
          "comment-review gate re-driven after an undelivered review event (BLO-39871)",
        );
      } else {
        result.failed += 1;
        log.warn(
          { repoFullName: input.repoFullName, prNumber: candidate.prNumber, reason: check.reason },
          "comment-review gate re-drive did not post",
        );
      }
    } catch (err) {
      result.failed += 1;
      log.warn(
        { err, repoFullName: input.repoFullName, prNumber: candidate.prNumber },
        "comment-review gate re-drive threw (isolated)",
      );
    }
  }

  return result;
}
