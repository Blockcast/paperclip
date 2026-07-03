// Bounded in-memory counters for blocker-resolved dependent wakes (BLO-13250).
// These track the outcome of every wake fired when a blocker issue transitions
// to `done`, across both dispatch paths:
//   - fast_path_*  — the immediate becameDone wake fired inline from the
//     PATCH /issues/:id and POST /issues/:id/comments handlers the moment the
//     blocker's status flips to `done`.
//   - sweep_*       — the periodic reconcileResolvedBlockerDependents sweep
//     that re-fires the wake for any dependent whose blockers are all done
//     but which was never woken (lost fast-path wake, process restart, etc).
//
// A sustained non-zero *_skipped or *_failed rate — especially outside a
// known ccrotate-capacity or budget-block window — means dependents are
// silently stalling behind resolved blockers. Reset on process restart;
// intended for operational visibility, not persistence.

export type BlockerResolvedWakeMetricKey =
  | "fast_path_sent"
  | "fast_path_skipped"
  | "fast_path_failed"
  | "sweep_sent"
  | "sweep_skipped"
  | "sweep_failed";

const MAX_COUNTER_VALUE = Number.MAX_SAFE_INTEGER;

const counters: Record<BlockerResolvedWakeMetricKey, number> = {
  fast_path_sent: 0,
  fast_path_skipped: 0,
  fast_path_failed: 0,
  sweep_sent: 0,
  sweep_skipped: 0,
  sweep_failed: 0,
};

export function incrementBlockerResolvedWakeMetric(key: BlockerResolvedWakeMetricKey): void {
  if (counters[key] < MAX_COUNTER_VALUE) {
    counters[key] += 1;
  }
}

export function getBlockerResolvedWakeMetric(key: BlockerResolvedWakeMetricKey): number {
  return counters[key];
}

export function resetBlockerResolvedWakeMetrics(): void {
  for (const key of Object.keys(counters) as BlockerResolvedWakeMetricKey[]) {
    counters[key] = 0;
  }
}

export function snapshotBlockerResolvedWakeMetrics(): Record<BlockerResolvedWakeMetricKey, number> {
  return { ...counters };
}
