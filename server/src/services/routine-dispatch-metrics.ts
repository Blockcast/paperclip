// Bounded in-memory counters for routine dispatch gating outcomes. These reset
// on process restart and are intended for operational visibility, not
// persistence -- mirrors the pattern in dep-blocked-metrics.ts.
//
// BLO-23379: `routine_dispatch_bypassed_parked_execution_issue` is the
// distinguishing signal between "a routine fire was skipped/coalesced because
// work is genuinely in flight" (no increment) and "a routine's only gating
// execution issue was parked on a long-horizon `scheduled_retry` and dispatch
// bypassed it to fire anyway" (increment). Without this, both cases look
// identical from the outside -- the routine just keeps firing -- so the fact
// that a bypass is happening at all is otherwise invisible.

export type RoutineDispatchMetricKey = "routine_dispatch_bypassed_parked_execution_issue";

const MAX_COUNTER_VALUE = Number.MAX_SAFE_INTEGER;

const counters: Record<RoutineDispatchMetricKey, number> = {
  routine_dispatch_bypassed_parked_execution_issue: 0,
};

export function incrementRoutineDispatchMetric(key: RoutineDispatchMetricKey): void {
  if (counters[key] < MAX_COUNTER_VALUE) {
    counters[key] += 1;
  }
}

export function getRoutineDispatchMetric(key: RoutineDispatchMetricKey): number {
  return counters[key];
}

export function resetRoutineDispatchMetrics(): void {
  for (const key of Object.keys(counters) as RoutineDispatchMetricKey[]) {
    counters[key] = 0;
  }
}

export function snapshotRoutineDispatchMetrics(): Record<RoutineDispatchMetricKey, number> {
  return { ...counters };
}
