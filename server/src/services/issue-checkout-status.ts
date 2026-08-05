import { and, eq, isNotNull, sql } from "drizzle-orm";
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
 * @returns true when a status was actually restored.
 */
export async function restoreCheckoutPromotedStatus(
  dbOrTx: {
    update: (table: typeof issues) => any;
  },
  issueId: string,
): Promise<boolean> {
  const restored = await dbOrTx
    .update(issues)
    .set({
      status: sql`${issues.checkoutRestoreStatus}`,
      checkoutRestoreStatus: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(issues.id, issueId),
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
      ),
    )
    .returning({ id: issues.id });

  return restored.length > 0;
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
