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

/**
 * Statuses in which a run demonstrably has not reached a process yet.
 *
 * PEN-3622 settled explicitly whether `scheduled_retry` belongs here: **it
 * does, and it must.** A parked run is not *overdue* while its horizon is in
 * the future, but a park whose due time has passed and that
 * `promoteScheduledRetryRun` has not picked up is precisely the strand PEN-3607
 * measured — a seat dark on a promotion sweep that wedged. Dropping the status
 * from this set would buy the false-positive fix by going blind to the real
 * strand. The remedy is the clock, not the membership: see
 * {@link dispatchableSince}.
 */
const UNDISPATCHED_HEARTBEAT_RUN_STATUSES = ["queued", "scheduled_retry"] as const;

export type StrandedRunRecoveryCandidate = {
  status: string;
  startedAt: Date | string | null;
  createdAt: Date | string | null;
  /**
   * Stamped by the transitions that put an *existing* row back into `queued`
   * (`promoteScheduledRetryRun`, `deferRunForK8sIsolationConflict`,
   * `deferRunForBranchClaimConflict`). Null on a fresh `queued` insert, where
   * `createdAt` already is the queue-entry time.
   */
  queuedAt?: Date | string | null;
  /**
   * On a row whose status *is* `scheduled_retry`, this is that row's own due
   * time — written at insert and gated on by the promotion sweep
   * (`lte(scheduledRetryAt, now)`). It is INBOUND on every other status (it
   * describes the park that produced the row), which is why only the
   * `scheduled_retry` arm reads it.
   */
  scheduledRetryAt?: Date | string | null;
  processPid?: number | null;
  processGroupId?: number | null;
};

export type StrandedRunRecoveryEligibility =
  | { eligible: true; undispatchedForMs: number }
  | { eligible: false; reason: string };

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The instant this run became the dispatcher's responsibility — i.e. the point
 * from which failing to dispatch it is a strand rather than correct waiting.
 *
 * PEN-3622: this is **per-status**, which is the finding. Measured against
 * `master` @ `9104e50b`, the three conventions already in the tree each answer
 * a different question and none of them is right for both statuses:
 *
 * | status | waiting for | dispatchable since |
 * |---|---|---|
 * | `queued`, fresh insert (`queuedAt` null) | the dispatcher | `createdAt` |
 * | `queued`, promoted or deferred | the dispatcher | `queuedAt` |
 * | `scheduled_retry` | **its own park to come due** | `scheduledRetryAt` |
 *
 * So `coalesce(queuedAt, createdAt)` — correct for the BLO-21116 age gauge,
 * which only ever reads `status = 'queued'` — is wrong here, because this
 * predicate also admits `scheduled_retry`, where neither column marks
 * dispatchability. Reading `createdAt` on a parked row reports its entire
 * backoff as undispatched wait: the exact conflation `queued_at` was added to
 * kill for the age gauge, surviving on this path because the service was never
 * migrated with it.
 *
 * Unmeasurable spans refuse rather than overstate, following the same
 * discipline as the `paperclipListParkedAgents` reader (PEN-3607): a wrong
 * verdict offered to an actor empowered to cancel is the cost being avoided.
 */
function dispatchableSince(
  run: StrandedRunRecoveryCandidate,
): { since: Date } | { unmeasurable: string } {
  if (run.status === "scheduled_retry") {
    const dueAt = toDate(run.scheduledRetryAt);
    if (!dueAt) {
      return {
        unmeasurable:
          "Run is parked on a scheduled retry with no usable due time, so its undispatched span cannot be measured.",
      };
    }
    return { since: dueAt };
  }

  const queuedAt = toDate(run.queuedAt);
  if (queuedAt) return { since: queuedAt };
  const createdAt = toDate(run.createdAt);
  if (!createdAt) {
    return { unmeasurable: "Run has no usable creation timestamp to age against." };
  }
  return { since: createdAt };
}

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
 *
 * Eligibility is three conjuncts, not two (PEN-3622): the run must be in an
 * undispatched status, must never have reached a process, **and** its dispatch
 * window must have opened at least {@link STRANDED_RUN_RECOVERY_MIN_AGE_MS}
 * ago. The third is what separates a stranded run from a correctly-parked one.
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
  const dispatchable = dispatchableSince(run);
  if ("unmeasurable" in dispatchable) {
    return { eligible: false, reason: dispatchable.unmeasurable };
  }
  const undispatchedForMs = now.getTime() - dispatchable.since.getTime();
  if (undispatchedForMs < 0) {
    // A park that has not come due. The run is waiting by design, however long
    // its row has existed — this is the PEN-3622 false positive.
    return {
      eligible: false,
      reason: `Run is parked until ${dispatchable.since.toISOString()} and is waiting by design, not stranded.`,
    };
  }
  if (undispatchedForMs < STRANDED_RUN_RECOVERY_MIN_AGE_MS) {
    return {
      eligible: false,
      reason: `Run has been undispatched for ${Math.round(undispatchedForMs / 1000)}s, below the ${
        Math.round(STRANDED_RUN_RECOVERY_MIN_AGE_MS / 60000)
      }m recovery threshold.`,
    };
  }
  return { eligible: true, undispatchedForMs };
}
