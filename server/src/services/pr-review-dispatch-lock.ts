import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const PR_REVIEW_DISPATCH_LOCK_PREFIX = "heartbeat:pr-review-dispatch:";

/**
 * Serialize the final queued-to-running claim for one PR across all reviewers.
 * The status check must remain in the same transaction as the caller's claim.
 */
export async function canClaimPrReviewTask(
  tx: DbTransaction,
  taskKey: string,
): Promise<boolean> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${PR_REVIEW_DISPATCH_LOCK_PREFIX + taskKey}, 0))`,
  );

  const activeRun = await tx
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.status, "running"),
        sql`coalesce(${heartbeatRuns.contextTaskKey}, ${heartbeatRuns.contextSnapshot} ->> 'taskKey') = ${taskKey}`,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return activeRun === null;
}
