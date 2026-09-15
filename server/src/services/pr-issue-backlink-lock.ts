import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { normalizePrReviewRepoFullName } from "./pr-review-duplicate-issue-guard.js";

const PR_ISSUE_BACKLINK_LOCK_PREFIX = "github:pr-issue-backlink:";

// How long a second delivery may queue for this PR's lock before giving up, and
// how long the holder may sit idle-in-transaction — i.e. inside its GitHub calls
// — before Postgres terminates it and releases the lock. Both sit far above the
// healthy critical-section cost; they exist to make pool exhaustion recoverable,
// not to bound normal work. Mirrors `withGithubStatusDeliveryLock`, which bounds
// the same shape for the same reason, with smaller numbers because this critical
// section is one unpaginated list plus at most one post rather than a paginated
// list plus retrying status writes.
const BACKLINK_LOCK_WAIT_TIMEOUT_MS = 10_000;
const BACKLINK_LOCK_HOLD_TIMEOUT_MS = 30_000;

export type PrIssueBackLinkLockTimeouts = {
  /** Max queue time for a waiter. Test-only override; production uses the default. */
  waitMs?: number;
  /** Max idle-in-transaction time for the holder. Test-only override. */
  holdMs?: number;
};

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
 * the lock has to outlive the read for the read to mean anything. That makes
 * the holder sit idle-in-transaction pinning a pool connection, and every
 * waiter queued on an untimed `pg_advisory_xact_lock` pins one too — so a
 * single hung GitHub call (these helpers pass no `AbortSignal`, so they are
 * uncapped) plus a burst of concurrent deliveries could occupy the 10-connection
 * pool and starve unrelated work. Worse, once the pool is exhausted the holder
 * cannot finish, so the lock is never released. Both sides are therefore
 * bounded; see the timeout constants above.
 *
 * On timeout the statement errors rather than returning, and the error
 * propagates to the caller's existing best-effort try/catch, which logs and
 * leaves the back-link unposted. That is the safe side of this trade: a missing
 * back-link is a cosmetic loss, a double-post is the defect being fixed. In the
 * healthy case no timeout is reached at all — the second delivery blocks
 * briefly, then reads the marker the first one wrote and correctly skips.
 */
export async function withPrIssueBackLinkLock<T>(
  db: Db,
  ref: { repoFullName: string; prNumber: number },
  post: () => Promise<T>,
  timeouts: PrIssueBackLinkLockTimeouts = {},
): Promise<T> {
  const waitMs = timeouts.waitMs ?? BACKLINK_LOCK_WAIT_TIMEOUT_MS;
  const holdMs = timeouts.holdMs ?? BACKLINK_LOCK_HOLD_TIMEOUT_MS;
  const key = `${PR_ISSUE_BACKLINK_LOCK_PREFIX}${normalizePrReviewRepoFullName(ref.repoFullName)}:${ref.prNumber}`;
  return db.transaction(async (tx) => {
    // set_config(..., true) is transaction-local; SET LOCAL cannot be
    // parameterized, so it is spelled this way deliberately.
    await tx.execute(sql`select set_config('lock_timeout', ${`${waitMs}ms`}, true)`);
    await tx.execute(
      sql`select set_config('idle_in_transaction_session_timeout', ${`${holdMs}ms`}, true)`,
    );
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return post();
  });
}

export const __test_prIssueBackLinkLockKey = (ref: { repoFullName: string; prNumber: number }): string =>
  `${PR_ISSUE_BACKLINK_LOCK_PREFIX}${normalizePrReviewRepoFullName(ref.repoFullName)}:${ref.prNumber}`;
