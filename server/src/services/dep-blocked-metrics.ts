// Bounded in-memory counters for dep-blocked wake coalescing. These reset on
// process restart and are intended for operational visibility, not persistence.
// Counter names mirror the heartbeat outcome kinds surfaced in structured logs.

export type DepBlockedMetricKey =
  | "dep_blocked_scheduled"
  | "dep_blocked_coalesced"
  | "dep_blocked_reset"
  | "dep_blocked_promoted"
  | "dep_blocked_redeferred"
  | "dep_blocked_exhausted"
  // Park terminated for exceeding DEP_BLOCKED_MAX_PARK_AGE_MS. Distinct from
  // dep_blocked_exhausted (attempt budget) because the age ceiling exists to catch
  // parks whose attempt counter was reset by blocker-set churn (BLO-29055) — the two
  // must stay separable to tell "waited too long" from "retried too often".
  | "dep_blocked_age_expired"
  // A re-park inherited its age origin from a park that the blockedInteractionWake
  // branch had cancelled on an earlier call (BLO-29729). Counted because that carry
  // cannot be inferred from any other counter: without it the re-park stamps a fresh
  // origin and looks identical to a genuine first park. Read it as "how often the
  // interaction-wake evasion was actually taken" — a persistently zero value on a
  // fleet with dep-blocked parks and comment traffic means the recovery is not
  // matching, not that the hole is unused.
  | "dep_blocked_origin_recovered"
  // An already-`queued` run cancelled out of band by `reapUnclaimableQueuedRuns`
  // because its issue was dependency-blocked (PEN-4385). Distinct from
  // dep_blocked_scheduled, which counts a wake PARKED before it ever reached
  // `queued`: these two measure the two different ways a blocked issue stops
  // consuming dispatch, and conflating them would hide whether the enqueue-time
  // park is doing its job. A persistently non-zero value here is normal (a run
  // enqueued against a ready issue that was blocked afterwards cannot be caught
  // at enqueue time); a persistently ZERO value on a fleet with dep-blocked
  // parks means the sweep is not reaching rows, not that none exist.
  | "dep_blocked_queued_reaped"
  // A dep-blocked park was terminated (attempt budget or age ceiling) while it was
  // the sole carrier of a RESOLVED interaction decision — a card a human accepted,
  // rejected or answered, whose wake had already been consumed (PEN-5206). Distinct
  // from dep_blocked_exhausted / dep_blocked_age_expired, which count the
  // terminations themselves: those are routine and mostly harmless, because an
  // ordinary park carries nothing a re-wake could not reconstruct. This one counts
  // the subset where termination destroyed information no later wake can recover,
  // so it must stay separable or the signal drowns in the routine terminations it
  // is a subset of. A non-zero value means a human decision was stranded and a
  // notice was written to the row; zero means none were, NOT that none can be.
  | "dep_blocked_terminated_carrying_decision";

const MAX_COUNTER_VALUE = Number.MAX_SAFE_INTEGER;

const counters: Record<DepBlockedMetricKey, number> = {
  dep_blocked_scheduled: 0,
  dep_blocked_coalesced: 0,
  dep_blocked_reset: 0,
  dep_blocked_promoted: 0,
  dep_blocked_redeferred: 0,
  dep_blocked_exhausted: 0,
  dep_blocked_age_expired: 0,
  dep_blocked_origin_recovered: 0,
  dep_blocked_queued_reaped: 0,
  dep_blocked_terminated_carrying_decision: 0,
};

export function incrementDepBlockedMetric(key: DepBlockedMetricKey): void {
  if (counters[key] < MAX_COUNTER_VALUE) {
    counters[key] += 1;
  }
}

export function getDepBlockedMetric(key: DepBlockedMetricKey): number {
  return counters[key];
}

export function resetDepBlockedMetrics(): void {
  for (const key of Object.keys(counters) as DepBlockedMetricKey[]) {
    counters[key] = 0;
  }
}

export function snapshotDepBlockedMetrics(): Record<DepBlockedMetricKey, number> {
  return { ...counters };
}
