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
