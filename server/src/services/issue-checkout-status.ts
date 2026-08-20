import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { TERMINAL_HEARTBEAT_RUN_STATUS_VALUES } from "./issue-execution-lock.js";
import { buildIssueMonitorEligibilityPatch } from "./issue-execution-policy.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

/**
 * The issue columns that jointly identify the current execution owner.
 *
 * Recovery observations carry this snapshot across a few awaits.  Consumers
 * must compare all three fields after taking the issue ownership lock; a
 * partial comparison can accept an adopter that changed only one half of the
 * execution lock pair.
 */
export type IssueLockOwnerState = {
  executionRunId: string | null;
  checkoutRunId: string | null;
  assigneeAgentId: string | null;
};

export function issueLockOwnerStateMatches(
  expected: IssueLockOwnerState,
  actual: IssueLockOwnerState,
): boolean {
  return expected.executionRunId === actual.executionRunId &&
    expected.checkoutRunId === actual.checkoutRunId &&
    expected.assigneeAgentId === actual.assigneeAgentId;
}

/**
 * Serialize every mutation that can transfer an issue's execution ownership.
 *
 * The recovery sweep and checkout adoption both perform several reads and
 * writes on pooled connections. A row lock alone cannot coordinate those
 * paths: recovery deliberately keeps its transaction open while its dependent
 * side effects use other connections. Keep this key in one helper so both
 * paths acquire the same transaction-scoped lock before taking the issue row
 * lock or making an ownership decision.
 */
export async function lockIssueOwnership(
  dbOrTx: Pick<DbOrTransaction, "execute">,
  companyId: string,
  issueId: string,
): Promise<void> {
  await dbOrTx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${companyId} || ':' || ${issueId}, 0))`,
  );
}

/**
 * Clear every issue-ownership column that still points at a terminalizing run.
 *
 * Each column is guarded independently so a stale finalizer cannot erase a
 * newer execution claim. The checkout column must be released alongside the
 * execution lock: restoring the queue-tier status while leaving a terminal
 * checkout owner behind makes the restored issue impossible to check out.
 */
export async function releaseIssueRunOwnership(
  dbOrTx: DbOrTransaction,
  target: { issueId: string; companyId: string; runId: string; updatedAt?: Date },
): Promise<boolean> {
  const released = await dbOrTx
    .update(issues)
    .set({
      checkoutRunId: sql<string | null>`case
        when ${issues.checkoutRunId} = ${target.runId} then null
        else ${issues.checkoutRunId}
      end`,
      executionRunId: sql<string | null>`case
        when ${issues.executionRunId} = ${target.runId} then null
        else ${issues.executionRunId}
      end`,
      executionAgentNameKey: sql<string | null>`case
        when ${issues.executionRunId} = ${target.runId} then null
        else ${issues.executionAgentNameKey}
      end`,
      executionLockedAt: sql<Date | null>`case
        when ${issues.executionRunId} = ${target.runId} then null
        else ${issues.executionLockedAt}
      end`,
      updatedAt: target.updatedAt ?? new Date(),
    })
    .where(
      and(
        eq(issues.id, target.issueId),
        eq(issues.companyId, target.companyId),
        or(eq(issues.checkoutRunId, target.runId), eq(issues.executionRunId, target.runId)),
      ),
    )
    .returning({ id: issues.id });

  return released.length > 0;
}

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
 * The columns {@link reconcileRestoredMonitors} needs to decide whether a
 * restored row still holds a deliverable monitor.
 *
 * `UPDATE ... RETURNING` yields the POST-update tuple, so `status` here is the
 * restored queue-tier status rather than the `in_progress` the row was demoted
 * from — which is exactly the shape the eligibility check has to run against.
 */
const restoreReturning = {
  id: issues.id,
  status: issues.status,
  assigneeAgentId: issues.assigneeAgentId,
  assigneeUserId: issues.assigneeUserId,
  executionPolicy: issues.executionPolicy,
  executionState: issues.executionState,
  monitorNextCheckAt: issues.monitorNextCheckAt,
  monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
  monitorLastTriggeredAt: issues.monitorLastTriggeredAt,
  monitorAttemptCount: issues.monitorAttemptCount,
  monitorNotes: issues.monitorNotes,
  monitorScheduledBy: issues.monitorScheduledBy,
};

type RestoredRow = {
  id: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionPolicy: unknown;
  executionState: unknown;
  monitorNextCheckAt: Date | null;
  monitorWakeRequestedAt: Date | null;
  monitorLastTriggeredAt: Date | null;
  monitorAttemptCount: number | null;
  monitorNotes: string | null;
  monitorScheduledBy: string | null;
};

/**
 * BLO-28900 — clear any monitor the restore just made undeliverable.
 *
 * Checkout promotes a queue-tier row to `in_progress`; a run arms a monitor
 * against that transient status; teardown restores the original status. The
 * monitor survives reading `scheduled` while `tickDueIssueMonitors` can no
 * longer select the row, so the issue goes dark looking like an idle assignee.
 *
 * The restore itself stays one set-based statement — the batch form exists
 * precisely so cleanup scales without N round-trips. Reconciliation is a
 * separate per-row pass because each row carries its own `executionPolicy` /
 * `executionState` JSON, and it runs only for rows that actually hold an armed
 * monitor. In the common case that is zero rows and zero extra statements.
 *
 * Each clear is a compare-and-swap on `(status, monitor_next_check_at)`. The
 * restore may commit outside a transaction, so a concurrent actor can re-promote
 * the row and arm a fresh monitor between the two statements; without the guard
 * this pass would silently delete that new monitor and cause the very stall it
 * exists to prevent. A lost CAS means the row is no longer the one we decided
 * about, so skipping is correct.
 */
async function reconcileRestoredMonitors(
  dbOrTx: DbOrTransaction,
  rows: readonly RestoredRow[],
): Promise<void> {
  for (const row of rows) {
    if (!row.monitorNextCheckAt) continue;
    const patch = buildIssueMonitorEligibilityPatch({
      status: row.status,
      assigneeAgentId: row.assigneeAgentId,
      assigneeUserId: row.assigneeUserId,
      executionPolicy: row.executionPolicy as Record<string, unknown> | null,
      executionState: row.executionState as Record<string, unknown> | null,
      monitorNextCheckAt: row.monitorNextCheckAt,
      monitorWakeRequestedAt: row.monitorWakeRequestedAt,
      monitorLastTriggeredAt: row.monitorLastTriggeredAt,
      monitorAttemptCount: row.monitorAttemptCount,
      monitorNotes: row.monitorNotes,
      monitorScheduledBy: row.monitorScheduledBy,
    });
    if (Object.keys(patch).length === 0) continue;
    await dbOrTx
      .update(issues)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(issues.id, row.id),
          eq(issues.status, row.status),
          eq(issues.monitorNextCheckAt, row.monitorNextCheckAt),
        ),
      );
  }
}

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
  dbOrTx: DbOrTransaction,
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
    .returning(restoreReturning);

  await reconcileRestoredMonitors(dbOrTx, restored as RestoredRow[]);

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
  dbOrTx: DbOrTransaction,
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
    .returning(restoreReturning);

  await reconcileRestoredMonitors(dbOrTx, restored as RestoredRow[]);

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
