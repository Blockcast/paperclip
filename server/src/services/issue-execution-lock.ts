import { HEARTBEAT_RUN_STATUSES, type HeartbeatRunStatus } from "@paperclipai/shared";

/**
 * Single source of truth for "does a run currently hold this issue's execution
 * lock?" (BLO-19749).
 *
 * An issue is locked by whichever run is named in `issues.checkoutRunId` or
 * `issues.executionRunId`, and that lock is *released* only when the named run
 * reaches a terminal status — `clearExecutionRunIfTerminal` /
 * `clearCheckoutRunIfTerminal` in `issues.ts` run at the top of `checkout()` and
 * null the columns for terminal runs before the conflict is evaluated. So a 409
 * `Issue checkout conflict` naming a run id means, by construction, that the run
 * is NOT terminal.
 *
 * "Holding" is therefore the exact complement of "terminal" over the run-status
 * domain, and the two sets below are pinned as complements by
 * `issue-execution-lock.test.ts`. That test is the point of this module: before
 * it existed the same notion was open-coded as three different literal arrays
 * that had silently drifted apart —
 *
 *   | notion                          | set                                  | site                 |
 *   |---------------------------------|--------------------------------------|----------------------|
 *   | lock held (checkout 409s)       | complement of terminal → +retry      | `issues.ts` checkout |
 *   | live execution path             | queued, running, scheduled_retry     | `heartbeat.ts:494`   |
 *   | `activeRun` exposed on the API  | queued, running  ← MISSING retry     | `issues.ts:2256`     |
 *
 * That last row was a reported defect, not a nuance: `GET /api/issues/{id}`
 * returned `activeRun: null` while `POST /checkout` simultaneously 409'd naming
 * the exact run id, because a `scheduled_retry` run holds the lock but was
 * filtered out of the `activeRun` hydration. Anything using `activeRun` to
 * detect that a sibling run already owns an issue — including the documented
 * cede-check — read a field that was silently blind to the entire retry ladder.
 */

/**
 * Run statuses that RELEASE an issue execution lock.
 *
 * Deliberately a superset of {@link HEARTBEAT_RUN_STATUSES}: `error` and
 * `adapter_failed` are not in the canonical union but have been observed in the
 * column, and treating an unknown-but-clearly-dead status as holding a lock
 * would strand the issue forever. Fail toward releasing.
 */
export const TERMINAL_HEARTBEAT_RUN_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "interrupted",
  "failed",
  "error",
  "adapter_failed",
  "cancelled",
  "timed_out",
]);

/**
 * Run statuses that HOLD an issue execution lock — the complement of
 * {@link TERMINAL_HEARTBEAT_RUN_STATUSES} over {@link HEARTBEAT_RUN_STATUSES}.
 *
 * `scheduled_retry` belongs here and is the one the drift above dropped: the
 * retry ladder parks a run in `scheduled_retry` while keeping the issue's lock
 * columns pointed at it, so such a run blocks checkout exactly as a `running`
 * one does.
 *
 * Note this is strictly weaker than "is executing": a `queued` or
 * `scheduled_retry` holder has no worktree. Callers that need "is actually
 * executing right now" must narrow further — see `isRunHoldingIssue`.
 */
export const ISSUE_EXECUTION_LOCK_HOLDING_RUN_STATUSES: readonly HeartbeatRunStatus[] =
  HEARTBEAT_RUN_STATUSES.filter((status) => !TERMINAL_HEARTBEAT_RUN_STATUSES.has(status));

/** Whether a run in `status` still holds any issue execution lock naming it.
 *
 * Strict complement of {@link TERMINAL_HEARTBEAT_RUN_STATUSES}: an UNRECOGNISED
 * status counts as holding. Use this when you have the run row in hand and are
 * deciding whether to defer to it — being wrong toward "someone else owns this"
 * costs a deferral, whereas being wrong the other way lets two runs edit one
 * worktree.
 *
 * SQL call sites deliberately invert that bias. They filter with
 * `inArray(status, ISSUE_EXECUTION_LOCK_HOLDING_RUN_STATUSES)` — an enumeration,
 * so an unrecognised status reads as NOT holding and the issue reads as
 * available. There the failure mode is reversed: a wake that runs unnecessarily
 * wastes one run, but an issue wrongly judged "held" by a status nothing will
 * ever clear is stranded with no wake path at all. Both directions fail toward
 * the recoverable error; they differ because the recoverable error differs.
 */
export function runStatusHoldsIssueExecutionLock(status: string | null | undefined): boolean {
  if (!status) return false;
  return !TERMINAL_HEARTBEAT_RUN_STATUSES.has(status);
}
