/**
 * BLO-21947: the precondition that makes non-board stranded-run recovery safe.
 *
 * This lives in its own module rather than in `heartbeat.ts` on purpose. It is a
 * pure policy predicate with no DB or runtime dependencies, and route code needs
 * it on the authorization path — importing it from the heartbeat service would
 * drag a 27k-line module (and its mocks) into every caller. Route tests
 * routinely replace `services/heartbeat.js` wholesale, which silently turns any
 * named export from it into `undefined` at the call site.
 */

/**
 * How long a run must sit undispatched before a managing agent may cancel it.
 * Aligned with BLO-21116's oldest-queued-run-age alert threshold — a healthy
 * dispatcher picks a run up in seconds, so 30m is far outside normal operation
 * while still leaving room for a briefly backed-up queue. The bound exists to
 * stop a manager racing the dispatcher, not to bound damage: a run that never
 * started has nothing to damage.
 */
export const STRANDED_RUN_RECOVERY_MIN_AGE_MS = 30 * 60 * 1000;

/** Statuses in which a run demonstrably has not been dispatched yet. */
const UNDISPATCHED_HEARTBEAT_RUN_STATUSES = ["queued", "scheduled_retry"] as const;

export type StrandedRunRecoveryCandidate = {
  status: string;
  startedAt: Date | string | null;
  createdAt: Date | string | null;
  processPid?: number | null;
  processGroupId?: number | null;
};

export type StrandedRunRecoveryEligibility =
  | { eligible: true; queuedForMs: number }
  | { eligible: false; reason: string };

/**
 * Decides whether a run is recoverable by a non-board manager.
 *
 * The safety property this encodes is `startedAt === null`. `cancelRunInternal`
 * only terminates a process when one exists, so cancelling a never-dispatched
 * run kills nothing, discards no tokens, and loses no work — it just releases
 * the issue execution lock and kicks `startNextQueuedRunForAgent`. The control
 * plane already performs exactly this transition on its own (see the
 * `duplicate_dispatch_suppressed` cancel path), which is what makes it safe to
 * expose to a manager under an auditable precondition rather than to the board
 * alone.
 *
 * A `running` run is deliberately NOT eligible at any age. Cancelling one
 * destroys in-flight work, which is why that stays board-only.
 */
export function evaluateStrandedRunRecovery(
  run: StrandedRunRecoveryCandidate,
  now: Date = new Date(),
): StrandedRunRecoveryEligibility {
  if (!UNDISPATCHED_HEARTBEAT_RUN_STATUSES.includes(
    run.status as (typeof UNDISPATCHED_HEARTBEAT_RUN_STATUSES)[number],
  )) {
    return { eligible: false, reason: `Run status ${run.status} is not an undispatched status.` };
  }
  // Belt-and-braces against a status/field skew: any of these being set means
  // the run reached a process, so it is not "never dispatched" whatever the
  // status column says.
  if (run.startedAt !== null && run.startedAt !== undefined) {
    return { eligible: false, reason: "Run has already started; cancelling it would discard in-flight work." };
  }
  if (run.processPid != null || run.processGroupId != null) {
    return { eligible: false, reason: "Run is bound to a process; cancelling it would discard in-flight work." };
  }
  const createdAt = run.createdAt instanceof Date ? run.createdAt : run.createdAt ? new Date(run.createdAt) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) {
    return { eligible: false, reason: "Run has no usable creation timestamp to age against." };
  }
  const queuedForMs = now.getTime() - createdAt.getTime();
  if (queuedForMs < STRANDED_RUN_RECOVERY_MIN_AGE_MS) {
    return {
      eligible: false,
      reason: `Run has been undispatched for ${Math.max(0, Math.round(queuedForMs / 1000))}s, below the ${
        Math.round(STRANDED_RUN_RECOVERY_MIN_AGE_MS / 60000)
      }m recovery threshold.`,
    };
  }
  return { eligible: true, queuedForMs };
}
