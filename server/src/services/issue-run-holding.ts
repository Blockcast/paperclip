// BLO-19001: is another live run already holding this issue?
//
// Two places need that answer, and they must agree:
//
//   1. Dispatch — startNextQueuedRunForAgent refuses to start a queued run
//      whose issue already has a non-stale running sibling
//      (heartbeat.ts, "Per-issue dedupe").
//   2. Self-selection — GET /agents/me/inbox-lite. An autonomous heartbeat run
//      carries no contextSnapshot.issueId, so it slips past (1) entirely and
//      picks its own issue *after* dispatch. Without a guard here it can pick
//      one a sibling run of the same agent is already working; under a shared
//      worktree both then edit one tree and one can delete the other's state.
//
// A duplicated staleness threshold is how these two drift apart, so the
// canonical definition lives here and heartbeat.ts imports it.
//
// Note: this is about wall-clock *holding* of an issue. It is unrelated to
// run-liveness.ts, which classifies whether a finished run's output was
// actionable.

/**
 * A run is treated as stale once it has been silent this long. Only a non-stale
 * run holds its issue: a run whose Job died without writing a terminal status
 * must not keep the issue locked forever.
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
 * True when the run is `running` and has shown a sign of life inside the
 * staleness window.
 *
 * A `queued` run is deliberately not holding: it has not started, owns no
 * worktree, and dispatch already cancels it if a running sibling claims the
 * issue first. Treating queued as holding would hide large amounts of ordinary
 * work from the inbox.
 *
 * A `running` row with no signal at all is treated as stale, not live — it is
 * indistinguishable from a run whose process died during startup, and holding
 * an issue on that basis strands it.
 */
export function isRunHoldingIssue(run: ActiveRunSignals, nowMs: number): boolean {
  if (run.status !== "running") return false;
  const signalMs = runLastSignalMs(run);
  if (signalMs == null) return false;
  return signalMs >= nowMs - RUN_STALE_SILENCE_MS;
}

/**
 * Whether an issue must be withheld from the caller because a *different* live
 * run already holds it.
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
