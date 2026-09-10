import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { heartbeatRuns, issueRelations, issues, type Db } from "@paperclipai/db";
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
 * BLO-29554 — a row parked on a monitor the run deliberately armed.
 *
 * These are the per-issue columns `tickDueIssueMonitors` dispatches on, minus
 * the due-time check: while this holds, the only thing about the *row* standing
 * between it and its wake is the `in_progress` status the restore is about to
 * take away.
 *
 * It is deliberately not the dispatcher's whole predicate. `tickDueIssueMonitors`
 * also joins `companies` and requires `status = 'active'`, and that condition is
 * excluded here on purpose, because the two predicates are answering different
 * questions. The dispatcher asks "can this fire *now*"; this guard asks "is the
 * scheduled work still worth keeping". Company status is the one input where
 * those diverge: `paused` and `archived` are both reversible administrative
 * states — `routes/companies.ts` handles `paused → active` and
 * `archived → active` explicitly, un-pausing the agents it parked — so a
 * non-active company means "not yet", not "never".
 *
 * Folding company status in would therefore make teardown during a pause restore
 * the row and let {@link reconcileRestoredMonitors} clear the monitor as
 * `invalid_status`, destroying the armed wake permanently. Reactivating the
 * company could not bring it back. That is precisely the loss this fix exists to
 * prevent, triggered by a routine admin action instead of a run ending. Holding
 * the promotion instead costs a stale-looking `in_progress` in a company where
 * nothing dispatches at all — inert while it stays non-active, and correct the
 * moment it comes back, because the monitor is still there to fire and the
 * preserved marker still lands the demotion at the end of the run it wakes.
 */
const holdsDispatchableMonitor = sql`(
  ${issues.monitorNextCheckAt} is not null
  and ${issues.assigneeAgentId} is not null
  and ${issues.assigneeUserId} is null
)`;

/**
 * The guard shared by both restore entry points: a checkout promotion may only be
 * undone while nothing else has a claim on the row.
 *
 * Kept as one expression so the single-issue and batch variants can never drift
 * apart — a divergence here would show up as an issue demoted out from under a
 * live run, which is the failure mode this whole guard exists to prevent.
 *
 * An armed monitor is one of those claims (BLO-29554). Checkout promotes a
 * queue-tier row to `in_progress`, a run parks the issue on a timed re-check and
 * arms a monitor against that status, and teardown used to restore the
 * queue-tier status underneath it. BLO-28900 made the outcome visible by
 * clearing the stranded monitor, which stops the row *lying* about being
 * scheduled — but the scheduled work is still lost, and losing it is the actual
 * cost: on BLO-30563 it was two nights of a nightly CronJob log that only exists
 * inside a retention window of hours.
 *
 * So keep the promotion rather than tidy up the corpse. While a dispatchable
 * monitor is armed, `in_progress` is not a stale checkout artifact — it is the
 * state the monitor needs in order to fire. The restore marker is deliberately
 * left in place, so the demotion still happens at the end of whichever run the
 * monitor wakes: deferred, not cancelled, and `in_progress` does not decay back
 * into the high-water mark BLO-20649 removed.
 */
const restorableCheckoutPromotion = and(
  eq(issues.status, "in_progress"),
  isNotNull(issues.checkoutRestoreStatus),
  sql`not ${holdsDispatchableMonitor}`,
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

/**
 * Does this row have a blocker that can still reach `done`?
 *
 * `issue_relations` stores "X is blocked by Y" as `type = 'blocks'` with
 * `issue_id = Y` and `related_issue_id = X`, so a row's own blockers are the
 * edges pointing *at* it. A blocker counts as resolved only when it is `done`
 * (`plugin-host-services.ts` filters `status !== "done"`), which is what
 * `issue_blockers_resolved_sweep` waits for before waking the dependent.
 */
const hasPendingBlocker = sql`exists (
  select 1
  from ${issueRelations}
  join ${issues} as blocker on blocker.id = ${issueRelations.issueId}
  where ${issueRelations.relatedIssueId} = ${issues.id}
    and ${issueRelations.companyId} = ${issues.companyId}
    and ${issueRelations.type} = 'blocks'
    and blocker.status not in ('done', 'cancelled')
)`;

/**
 * A `cancelled` blocker never reaches `done`, so it can never resolve.
 *
 * The resolved sweep fires on the transition to "every blocker done"; one
 * cancelled edge means that condition is unreachable, so the dependent waits
 * forever. A cancelled edge is therefore worse than no edge — it looks like a
 * live dependency on every triage surface.
 */
const hasCancelledBlocker = sql`exists (
  select 1
  from ${issueRelations}
  join ${issues} as blocker on blocker.id = ${issueRelations.issueId}
  where ${issueRelations.relatedIssueId} = ${issues.id}
    and ${issueRelations.companyId} = ${issues.companyId}
    and ${issueRelations.type} = 'blocks'
    and blocker.status = 'cancelled'
)`;

/**
 * BLO-33144 — the status to restore to, which is NOT always the recorded marker.
 *
 * `checkout` accepts `blocked` in `expectedStatuses`, so a row that was
 * `blocked` when a run picked it up records `blocked` as its restore marker. The
 * recovery path also *writes* `blocked` on a stranded row ("moving it to
 * `blocked` so it is visible for intervention"), and a later checkout of that
 * row records `blocked` in turn — so the marker is minted far more often than
 * genuine dependency-blocking would suggest.
 *
 * Restoring `blocked` verbatim is only safe when a blocker edge will actually
 * wake the row. The heartbeat skips `blocked`, so `blocked` with no resolvable
 * edge has no wake path at all: not a slow queue, a one-way ratchet that is
 * indistinguishable from a correctly-blocked row on every triage surface, so
 * nobody comes looking (BLO-27553). Measured on the 2026-09-10 cohort this
 * drain exists for: **141 of 141** rows whose marker was `blocked` had zero
 * blocker edges. A verbatim restore would have converted 141 visible rows —
 * rows that mint recovery actions and productivity reviews precisely *because*
 * they are loud — into 141 silent permanent strands. That is a worse state than
 * the bug, reached by something that looks like cleanup.
 *
 * So `blocked` is restored only when the row has at least one pending blocker
 * and no cancelled one; otherwise the row lands in `todo`, which keeps it in
 * `inbox-lite` and re-dispatchable. Every other marker restores verbatim.
 */
const checkoutRestoreTargetStatus = sql`case
  when ${issues.checkoutRestoreStatus} <> 'blocked' then ${issues.checkoutRestoreStatus}
  when ${hasPendingBlocker} and not ${hasCancelledBlocker} then 'blocked'
  else 'todo'
end`;

/**
 * BLO-29913 — `started_at` is part of the promotion, so undoing the promotion
 * must clear it.
 *
 * `checkoutStartedAtForCurrentRow` stamps `started_at = now()` on exactly the
 * transition this function reverses: it writes the clock only when checkout
 * actually promotes a queue-tier row, and preserves the existing value when the
 * row was already `in_progress`. The restore is therefore symmetric — it can
 * only fire while `checkout_restore_status` is set, which is only true for a
 * promotion that stamped the clock in the first place, so this never discards a
 * timestamp some other writer owns.
 *
 * Leaving it set is the load-bearing half of the bug. `long_active_duration`
 * measures wall-clock from `issues.started_at` to now, so a row restored to
 * `todo` with a stale `started_at` keeps accruing active duration in a queue
 * tier it is no longer being worked in, and mints a productivity review at 6h
 * for an episode that ended when the run died.
 */
const restoreCheckoutPromotionSet = () => ({
  status: checkoutRestoreTargetStatus,
  checkoutRestoreStatus: null,
  startedAt: null,
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
 * Since BLO-29554 the restore declines outright while a *dispatchable* monitor
 * is armed, so the status half of that conflict no longer reaches here. What
 * still does is the assignee half: a row whose monitor outlived its agent
 * assignee is undeliverable no matter which status it lands on, and there is no
 * promotion worth keeping for it. This pass is also shared with
 * `issueService.release()`, which strips the assignee deliberately.
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
 * BLO-33144 — restore every promotion that no run can ever carry back.
 *
 * The reconciliation half of BLO-29913. That fix made `sweepStaleIssueLocks`
 * restore the promotion when it clears a lock, which stops new strands, but it
 * is forward-only and structurally cannot drain the ones already there: the
 * sweep selects on `checkout_run_id is not null or execution_run_id is not
 * null`, and an earlier sweep pass already nulled both columns on these rows
 * without restoring the status. There is no lock left to find, so the fixed
 * sweep never selects them. Measured 2026-09-10: **225 of 225** drainable rows
 * had both lock columns NULL, i.e. every one was unreachable by the fix.
 *
 * Both-columns-NULL is exactly the condition that makes a row unreachable from
 * every other call site — those all take their issue ids from run context, and
 * a row with no run reference appears in none of them. So that is the predicate
 * here, which also keeps this pass disjoint from the sweep's: a row whose lock
 * still points at a terminal run is the sweep's to clear and restore in one
 * pass, and is deliberately left alone.
 *
 * Guarded by the same {@link restorableCheckoutPromotion} the single-issue and
 * batch forms use, so the drain and the steady-state path cannot diverge — a
 * divergence would show up as a row demoted out from under a live run. That
 * shared guard also makes this idempotent for free: the restore clears
 * `checkout_restore_status`, so a drained row no longer matches and a second
 * pass mutates nothing. The same property covers concurrent API replicas: two
 * sweeps racing this statement serialize on the row lock, and the loser
 * re-evaluates the predicate against the committed tuple and skips.
 *
 * Deliberately not company-scoped, unlike the two run-context forms. Those take
 * an issue id from persisted context, where the id is not guaranteed to belong
 * to the company whose lock the caller just released, so scoping is what makes a
 * cross-company reset structurally impossible. This one takes no ids at all — it
 * selects purely by shape, like the lock sweep it runs inside — so there is no
 * caller-supplied id to mis-scope, and reconciliation has to span every company
 * to do its job.
 *
 * @returns the ids actually restored.
 */
export async function restoreStrandedCheckoutPromotions(
  dbOrTx: DbOrTransaction,
): Promise<string[]> {
  const restored = await dbOrTx
    .update(issues)
    .set(restoreCheckoutPromotionSet())
    .where(
      and(
        isNull(issues.checkoutRunId),
        isNull(issues.executionRunId),
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
