import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { normalizePrReviewRepoFullName } from "./pr-review-duplicate-issue-guard.js";

const PR_ISSUE_BACKLINK_LOCK_PREFIX = "github:pr-issue-backlink:";

/**
 * Serialize the "read the comments, look for the marker, post if absent"
 * sequence for one pull request.
 *
 * The hidden `<!-- paperclip-issue-backlink -->` marker makes the back-link
 * post idempotent only if the read and the write are atomic with respect to
 * each other. They were not: two deliveries of the same `pull_request` event
 * could both list the comments before either had posted, both observe no
 * marker, and both post. That is not theoretical — Blockcast/paperclip#1738
 * carries two byte-identical back-link comments 2s apart (10:59:44Z /
 * 10:59:46Z), which is the check-then-act window, not a redelivery the marker
 * was ever able to catch.
 *
 * The lock namespace is case-normalized for the same reason
 * `canClaimPrReviewTask` normalizes its own: GitHub owner/repo identity is
 * case-insensitive, but the producers spell it differently, and two spellings
 * of one repository hash to two different advisory-lock ids — which would
 * leave the two deliveries racing through the very gate meant to stop them.
 *
 * The transaction is held across the two GitHub calls, which is deliberate:
 * the lock has to outlive the read for the read to mean anything. The cost is
 * bounded — this path runs only on PR open/reopen, reads a single page of
 * comments and posts at most one comment, and the caller already treats the
 * whole block as best-effort inside a try/catch. A second delivery blocks
 * briefly, then reads the marker the first one wrote and correctly skips.
 */
export async function withPrIssueBackLinkLock<T>(
  db: Db,
  ref: { repoFullName: string; prNumber: number },
  post: () => Promise<T>,
): Promise<T> {
  const key = `${PR_ISSUE_BACKLINK_LOCK_PREFIX}${normalizePrReviewRepoFullName(ref.repoFullName)}:${ref.prNumber}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return post();
  });
}

export const __test_prIssueBackLinkLockKey = (ref: { repoFullName: string; prNumber: number }): string =>
  `${PR_ISSUE_BACKLINK_LOCK_PREFIX}${normalizePrReviewRepoFullName(ref.repoFullName)}:${ref.prNumber}`;
