import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { heartbeatRuns, issues } from "@paperclipai/db";

/**
 * Heartbeat run statuses that hold no further claim on an issue. A run in any of
 * these is done — it will not write to the issue again — so the issue's execution
 * lock and its checkout-promoted status can both be released.
 *
 * Canonical list; `issues.ts` re-exports it as `TERMINAL_HEARTBEAT_RUN_STATUSES`.
 */
export const TERMINAL_HEARTBEAT_RUN_STATUS_VALUES = [
  "succeeded",
  "interrupted",
  "failed",
  "error",
  "adapter_failed",
  "cancelled",
  "timed_out",
] as const;

/**
 * The guard shared by both restore entry points: a checkout promotion may only be
 * undone while nothing else has a claim on the row.
 *
 * Kept as one expression so the single-issue and batch variants can never drift
 * apart — a divergence here would show up as an issue demoted out from under a
 * live run, which is the failure mode this whole guard exists to prevent.
 */
const restorableCheckoutPromotion = and(
  eq(issues.status, "in_progress"),
  isNotNull(issues.checkoutRestoreStatus),
  // `x IN (NULL)` is NULL rather than true, so a row with both lock columns
  // already cleared correctly matches NOT EXISTS and is restored.
  sql`not exists (
    select 1 from ${heartbeatRuns}
    where ${heartbeatRuns.id} in (${issues.checkoutRunId}, ${issues.executionRunId})
      and ${heartbeatRuns.status} not in ${sql.raw(
        `(${TERMINAL_HEARTBEAT_RUN_STATUS_VALUES.map((s) => `'${s}'`).join(", ")})`,
      )}
  )`,
);

const restoreCheckoutPromotionSet = () => ({
  status: sql`${issues.checkoutRestoreStatus}`,
  checkoutRestoreStatus: null,
  updatedAt: new Date(),
});

/**
 * Undo a checkout's `in_progress` promotion when the run released without
 * advancing the issue.
 *
 * `checkout` records the pre-checkout status in `checkout_restore_status` and
 * promotes the row to `in_progress`. Every lock-release path used to clear only
 * the execution-lock columns, so the promotion survived forever and `in_progress`
 * decayed into a high-water mark of every issue any wake had ever touched
 * (BLO-20649).
 *
 * This is a single guarded statement, so it is safe to call from inside the same
 * transaction that clears the lock. It no-ops unless ALL of:
 *
 *   - the issue is still `in_progress` — a run that advanced it to `in_review`,
 *     `done` or `blocked` keeps the status it set;
 *   - a restore marker is present — any explicit status write clears the marker,
 *     so a deliberate `in_progress` write is never clobbered either;
 *   - neither `checkout_run_id` nor `execution_run_id` points at a live run — a
 *     still-executing run keeps its claim.
 *
 * Note both lock columns are checked, not just the one the caller cleared: a
 * caller that releases only the execution lock must not reset the status while a
 * live checkout still owns the row.
 *
 * `companyId` is required rather than inferred. Callers reach this from run
 * context (`gate.issueId`, a run's context snapshot), and an issue id read back
 * from persisted context is not guaranteed to belong to the company whose lock
 * the caller just released. Scoping the predicate makes a cross-company reset
 * structurally impossible instead of relying on every caller to pre-check.
 *
 * @returns true when a status was actually restored.
 */
export async function restoreCheckoutPromotedStatus(
  dbOrTx: {
    update: (table: typeof issues) => any;
  },
  target: { issueId: string; companyId: string },
): Promise<boolean> {
  const restored = await dbOrTx
    .update(issues)
    .set(restoreCheckoutPromotionSet())
    .where(
      and(
        eq(issues.id, target.issueId),
        eq(issues.companyId, target.companyId),
        restorableCheckoutPromotion,
      ),
    )
    .returning({ id: issues.id });

  return restored.length > 0;
}

/**
 * Batch form of {@link restoreCheckoutPromotedStatus}, for callers releasing a
 * run's lock across every sibling issue at once.
 *
 * One statement rather than one per issue: the primary finalizer deliberately
 * clears its lock columns set-based so cleanup scales with the orphan count
 * without N round-trips, and restoration has to hold that same property or it
 * silently becomes the slow half of the same transaction.
 *
 * @returns the ids actually restored.
 */
export async function restoreCheckoutPromotedStatuses(
  dbOrTx: {
    update: (table: typeof issues) => any;
  },
  target: { issueIds: readonly string[]; companyId: string },
): Promise<string[]> {
  if (target.issueIds.length === 0) return [];

  const restored = await dbOrTx
    .update(issues)
    .set(restoreCheckoutPromotionSet())
    .where(
      and(
        inArray(issues.id, [...target.issueIds]),
        eq(issues.companyId, target.companyId),
        restorableCheckoutPromotion,
      ),
    )
    .returning({ id: issues.id });

  return restored.map((row: { id: string }) => row.id);
}

/**
 * The value `checkout` should write to `checkout_restore_status` when it promotes
 * a row to `in_progress`.
 *
 * Evaluated against the row's PRE-update column values (Postgres `UPDATE ... SET`
 * reads the old tuple), so it captures the status the issue actually held.
 *
 * A row already sitting in `in_progress` has no meaningful pre-checkout status to
 * capture: either an earlier checkout's marker is still there and must be kept,
 * or the row is one of the pre-existing strands this fix exists to drain, which
 * restores to `todo`.
 */
export const checkoutRestoreStatusExpression = sql`case
  when ${issues.status} = 'in_progress' then coalesce(${issues.checkoutRestoreStatus}, 'todo')
  else ${issues.status}
end`;
