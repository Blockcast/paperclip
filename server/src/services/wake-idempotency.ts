import { and, eq, inArray } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";

/**
 * Wake-request statuses that constitute a *durable receipt* for an idempotency
 * key — proof that the wake this key names has already been accepted.
 *
 * `completed` is the load-bearing member. Live coalescing (see the task-scope
 * merge in `heartbeat.ts`) only matches runs that are still queued/running, so it
 * answers "is an equivalent wake pending?" and stops answering once the run
 * finishes. A caller that must not wake twice *ever* — because its own retry is
 * driven by a crash-recovery reconciler, not by a user action — needs the
 * question answered across completion too. That is what this list is for.
 */
export const WAKE_IDEMPOTENCY_RECEIPT_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "completed",
] as const;

/**
 * Look up the durable receipt for a wake idempotency key.
 *
 * Returns the accepted wake request when this key has already been honoured, so
 * an at-least-once retry can skip a non-idempotent wake sink rather than create a
 * second run for the same logical event.
 *
 * This is a *check-then-act* guard, not a uniqueness constraint: two workers
 * racing the same key can both miss the receipt. It is the right tool where the
 * retries are serialized by something else (an effect-ledger claim, a lease) and
 * the failure being closed is "execute, die, re-execute after the first run
 * already finished".
 */
export async function findWakeIdempotencyReceipt(
  db: Db,
  input: { companyId: string; idempotencyKey: string },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, [...WAKE_IDEMPOTENCY_RECEIPT_STATUSES]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}
