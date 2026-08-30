import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import {
  matchesTaskKey,
  prReviewTaskLockSpellings,
} from "./pr-review-duplicate-issue-guard.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const PR_REVIEW_DISPATCH_LOCK_PREFIX = "heartbeat:pr-review-dispatch:";

/**
 * Serialize the final queued-to-running claim for one PR across all reviewers.
 * The status check must remain in the same transaction as the caller's claim.
 *
 * Both the lock namespace and the running-run check are casing-compatible.
 * GitHub owner/repo identity is case-insensitive, and the two producers spell
 * it differently mid-rollout: the webhook writes GitHub's mixed-case
 * `repoFullName` (buildPrReviewerTaskKey), while an issue-assignment wake
 * derives its key from the normalized `origin_fingerprint`. Comparing bytes
 * here would let a normalized claim miss a running mixed-case review of the
 * same PR — and hash to a different advisory-lock id, so nothing would stop
 * them racing — dispatching two concurrent reviews of one pull request. That
 * is the double dispatch BLO-20074 exists to close, arriving through the one
 * gate meant to prevent it.
 */
export async function canClaimPrReviewTask(
  tx: DbTransaction,
  taskKey: string,
): Promise<boolean> {
  for (const spelling of prReviewTaskLockSpellings(taskKey)) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${PR_REVIEW_DISPATCH_LOCK_PREFIX + spelling}, 0))`,
    );
  }

  const activeRun = await tx
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.status, "running"),
        matchesTaskKey(
          sql`coalesce(${heartbeatRuns.contextTaskKey}, ${heartbeatRuns.contextSnapshot} ->> 'taskKey')`,
          taskKey,
        ),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return activeRun === null;
}
