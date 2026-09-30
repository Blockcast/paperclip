import { and, eq, inArray } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";

/**
 * Wake-request statuses that constitute a *durable receipt* for an idempotency
 * key — proof that the wake this key names has already been accepted.
 *
 * The membership rule is "was this delivery accepted?", NOT "did it finish?".
 * Every state below is reached only after the wake was honoured, so seeing any
 * of them means a second dispatch would duplicate a wake that already happened:
 *
 * - `queued` / `deferred_issue_execution` — accepted, not yet started.
 * - `claimed` — accepted and currently executing.
 * - `coalesced` — accepted and merged into an existing run. The merge row is
 *   written with this key and the surviving `runId` (`heartbeat.ts`), so it is
 *   as much a receipt as a run of its own.
 * - `completed` — accepted and finished. Load-bearing, because live coalescing
 *   only matches runs that are still queued/running: it stops answering once
 *   the run finishes, and a retry driven by a crash-recovery reconciler rather
 *   than a user action needs the question answered across completion too.
 * - `dispatch_recovered` — the inline dispatch failed but `reconcileFailedWake
 *   Dispatches` re-delivered it; that path's own comment is explicit that "the
 *   delivery reached the queued state after all, just later than the inline
 *   path" (`heartbeat.ts`). Delivered is delivered.
 *
 * Excluded, and each for its own reason rather than as a family:
 * - `failed`, `cancelled`, `skipped`, `dispatch_failed_exhausted` — the wake
 *   never produced a run, so a retry is a legitimate second chance.
 * - `dispatch_failed` — an inline failure whose retry chain is still in flight.
 *   Reconciliation *usually* re-delivers within ~15m, but nothing here proves
 *   it will, and suppressing a wake that never happened is a worse failure than
 *   an extra one. Excluded deliberately, accepting a possible duplicate.
 * - `dispatch_superseded` — deferred in favour of a `scheduled_retry` run.
 *   Excluded on the same conservative grounds. Note `github-webhook.ts` makes
 *   the opposite call for `dispatch_failed`/`dispatch_superseded`, because a
 *   reviewer wake that fires twice is cheap; here the asymmetry is intentional.
 *
 * NOT identical to `IDEMPOTENT_DEPENDENCY_WAKE_STATUSES` in
 * `issue-dependency-wakeups.ts`, which asks the same question of the same table
 * but omits `coalesced` and `dispatch_recovered`. That looks like the same
 * latent double-wake gap this list was widened to close; it is left alone here
 * rather than changed blind, since its callers were not reviewed for this.
 */
export const WAKE_IDEMPOTENCY_RECEIPT_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "coalesced",
  "completed",
  "dispatch_recovered",
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
