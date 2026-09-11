// BLO-19001: is another run already holding this issue?
//
// Two places need that answer, and they must agree:
//
//   1. Dispatch — startNextQueuedRunForAgent refuses to start a queued run
//      whose issue already has a running sibling
//      (heartbeat.ts, "Per-issue dedupe").
//   2. Self-selection — GET /agents/me/inbox-lite. An autonomous heartbeat run
//      carries no contextSnapshot.issueId, so it slips past (1) entirely and
//      picks its own issue *after* dispatch. Without a guard here it can pick
//      one a sibling run of the same agent is already working; under a shared
//      worktree both then edit one tree and one can delete the other's state.
//
// Use the conservative ownership answer here: while the DB says a sibling run
// is running, do not hand the same issue to another autonomous run. A silent
// external Kubernetes Job can still be active and editing its worktree.
//
// Note: this is about issue/worktree ownership. It is distinct from heartbeat
// slot accounting and run-liveness.ts, which classify capacity and whether a
// finished run's output was actionable.

/**
 * A run is treated as stale for heartbeat slot accounting once it has been
 * silent this long. Do not use this as issue/worktree ownership authority:
 * external jobs can be quiet while still editing their workspace.
 */
export const RUN_STALE_SILENCE_MS = 15 * 60 * 1000;

/**
 * BLO-29965: how long past its own `scheduledRetryAt` a parked run still counts
 * as holding its issue for self-selection.
 *
 * A retry is NOT dispatched at its due time. BLO-28863 measured scheduled
 * retries dispatching 25–74 min after their own `scheduledRetryAt`, so a
 * horizon that has just passed says nothing about whether the retry is dead —
 * it is usually merely late and about to run. Releasing at the due instant
 * would reopen this issue's race precisely in the window where it is most
 * likely to fire.
 *
 * The bound exists at all because a retry that never fires must not strand the
 * row forever: past this grace we stop deferring and let the issue be picked
 * again. 2h sits comfortably above the measured worst-case lateness while
 * keeping the strand bounded. Capping the retry horizon itself is BLO-28919 and
 * deliberately not done here.
 */
export const SCHEDULED_RETRY_HOLD_GRACE_MS = 2 * 60 * 60 * 1000;

/** The fields needed to judge whether a run is still holding its issue. */
export type ActiveRunSignals = {
  id: string;
  status: string;
  startedAt?: Date | string | null;
  lastOutputAt?: Date | string | null;
  lastUsefulActionAt?: Date | string | null;
};

function toMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Most recent sign of life, strongest signal first:
 * lastUsefulActionAt > lastOutputAt > startedAt. Null when the run has emitted
 * nothing at all.
 */
export function runLastSignalMs(run: ActiveRunSignals): number | null {
  return toMs(run.lastUsefulActionAt) ?? toMs(run.lastOutputAt) ?? toMs(run.startedAt);
}

/**
 * True when the run is `running`.
 *
 * A `queued` run is deliberately not holding: it has not started, owns no
 * worktree, and dispatch already cancels it if a running sibling claims the
 * issue first. Treating queued as holding would hide large amounts of ordinary
 * work from the inbox.
 *
 * A `running` row with no signal at all still holds the issue. Silence alone is
 * not proof that an external runtime lost ownership; takeover needs a terminal
 * run or an authoritative lifecycle check outside this helper.
 */
export function isRunHoldingIssue(run: ActiveRunSignals, _nowMs: number): boolean {
  return run.status === "running";
}

/**
 * Whether an issue must be withheld from the caller because a *different*
 * running run already holds it.
 *
 * Fails OPEN when `callerRunId` is absent: a caller that sent no
 * x-paperclip-run-id gets the unfiltered list. Failing closed would hide an
 * agent's own in-progress issue from itself; it would read that as "no work"
 * and exit, trading a rare collision for routine stranding.
 */
export function isIssueHeldByForeignRun(input: {
  activeRun: ActiveRunSignals | null | undefined;
  callerRunId: string | null | undefined;
  nowMs: number;
}): boolean {
  const { activeRun, callerRunId, nowMs } = input;
  if (!activeRun) return false;
  if (!callerRunId) return false; // fail open — see above
  if (activeRun.id === callerRunId) return false; // the caller *is* the holder
  return isRunHoldingIssue(activeRun, nowMs);
}

/**
 * BLO-29965: whether an issue must be withheld because a *different* run of
 * this agent is parked on a still-live scheduled retry for it.
 *
 * This is the hole {@link isIssueHeldByForeignRun} above cannot see, and it is
 * not a nuance — it is the measured mechanism behind two duplicate-work
 * incidents:
 *
 *   - 2026-08-23, `penstock-llm-proxy-core` #1503 vs #1504: two runs of one
 *     agent independently derived the same hotfix on a red `main`, and one
 *     run's `git push` to the other's branch was rejected non-fast-forward.
 *   - 2026-09-03, BLO-31354 / `paperclip` #1612: run A parked at 01:52Z on
 *     `scheduledRetryReason: ccrotate_capacity` with `scheduledRetryAt`
 *     02:22:54Z; run B woke at 02:18Z — 4 min before A's retry — read the row
 *     as unattended and started the same fix. A's retry then pushed at
 *     02:33Z and B's push was rejected.
 *
 * A `scheduled_retry` run HOLDS the issue execution lock: it is the complement
 * of terminal, so `checkout()` 409s naming it (see `issue-execution-lock.ts`).
 * `isRunHoldingIssue` nevertheless answers only `status === "running"`, and the
 * parked run is frequently not in `activeRun` at all — that projection is
 * hydrated from `issues.executionRunId`, which an autonomous retry chain never
 * set. So the guard that exists to stop self-selection collisions was blind to
 * the entire retry ladder, and the row was offered to a sibling.
 *
 * Unlike a `queued` run — which owns no worktree and which dispatch cancels if
 * a running sibling claims the issue first — a parked retry is a *continuation
 * of work already begun*. It carries context and it will resume.
 *
 * Fails OPEN on every uncertainty, because the mirror failure is worse than the
 * one being fixed: withholding an issue we cannot *prove* is foreign hides an
 * agent's own work from its own inbox, which it reads as "no work" and exits —
 * trading a duplicated run for a silent strand. So we defer only when the retry
 * is armed, provably owned by another run, and not lapsed past
 * {@link SCHEDULED_RETRY_HOLD_GRACE_MS}.
 *
 * DO NOT gate this on the retry run's `startedAt`, however tempting the symmetry
 * with `isReapableHeartbeatRunRow` looks — it would revert this fix to a no-op.
 * A parked retry has `startedAt == null` BY CONSTRUCTION, always. All four
 * writers of that status are fresh INSERTs and not one of them sets the column
 * — the continuation, ccrotate-capacity and dependency-blocked ladders in
 * `heartbeat.ts` plus provider-quota recovery in `recovery/service.ts` — no
 * UPDATE path ever transitions an existing row *into* `scheduled_retry`, and
 * `heartbeat_runs.started_at` is a plain nullable timestamp with no database
 * default. So "only defer to retries that actually started" defers to none of
 * them.
 *
 * The asymmetry with checkout is deliberate, not drift. `checkout()` asks *may a
 * run that deliberately asked for this row adopt the lock?* and answers yes — a
 * parked retry owns no worktree, and refusing made WIP monotonic (BLO-20321).
 * This predicate asks *may we spontaneously offer this row to a sibling that
 * asked for nothing?* and answers no, because that offer is the measured
 * generator of the duplicate work above. Withholding never blocks recovery:
 * explicit checkout, recovery actions and monitor wakes all bypass the inbox,
 * the holder's own retry fails open by run id, and the strand is bounded by the
 * grace window. Pinned by "does NOT consult startedAt" in
 * `issue-run-holding.test.ts`.
 *
 * SIBLING means *same agent*, so the retry's owner is compared, not just its run
 * id. Review round 3 caught the gap: an issue reassigned from agent A to agent B
 * keeps A's `scheduled_retry` row alive — `issues.update` nulls only the
 * issue-side lock columns (`checkoutRunId`/`executionRunId`) and never touches
 * `heartbeat_runs` — so B's inbox saw a retry run id that was merely *not its
 * own* and withheld B's freshly-assigned row for up to the grace window.
 *
 * That withholding buys nothing, because A's retry can no longer run: promotion
 * gates on `issue.assigneeAgentId !== run.agentId` and cancels it
 * `issue_reassigned` (heartbeat.ts). It is also self-sustaining — the sweep that
 * would clear the stale row runs from `enqueueWakeup`, and an agent whose inbox
 * looks empty exits without enqueuing anything. So a cross-agent retry is
 * exactly the "cannot prove it is a sibling" case the fail-open discipline above
 * exists for.
 */
export function isIssueHeldByForeignScheduledRetry(input: {
  scheduledRetryAt: Date | string | null | undefined;
  scheduledRetryRunId: string | null | undefined;
  scheduledRetryAgentId: string | null | undefined;
  callerRunId: string | null | undefined;
  callerAgentId: string | null | undefined;
  nowMs: number;
}): boolean {
  const { scheduledRetryAt, scheduledRetryRunId, scheduledRetryAgentId, callerRunId, callerAgentId, nowMs } = input;
  // No armed retry, or no identifiable holder: nothing we can prove is foreign.
  if (!scheduledRetryRunId) return false;
  const dueMs = toMs(scheduledRetryAt);
  if (dueMs == null) return false;
  if (!callerRunId) return false; // fail open — same discipline as above
  if (scheduledRetryRunId === callerRunId) return false; // the caller's own retry
  // Owner unknown on either side: cannot prove this is a sibling. Fail open.
  // Both identities are required fields, so a call site that forgets to wire one
  // is a compile error rather than a guard that quietly stops guarding.
  if (!scheduledRetryAgentId || !callerAgentId) return false;
  if (scheduledRetryAgentId !== callerAgentId) return false; // another agent's retry
  // Lapsed well past its horizon: stop deferring so a dead retry cannot strand
  // the row forever.
  return nowMs <= dueMs + SCHEDULED_RETRY_HOLD_GRACE_MS;
}
