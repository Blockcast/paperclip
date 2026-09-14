// Single-flight latch for periodic sweeps driven by `setInterval` (BLO-30203).
//
// `setInterval` starts the next callback on schedule regardless of whether the
// previous one has settled, so a sweep that outlives its own interval runs
// concurrently with itself and each overlapping copy retains its own working
// set. For the heartbeat recovery chain that working set is a full hydrated
// snapshot of the issue graph, which is how the worker walked up to its 6 GiB
// --max-old-space-size ceiling and SIGABRTed roughly every two days.
//
// `createSingleFlight()` returns a runner that starts the task only when no
// previous invocation is still settling, and returns `null` when it declines.
// Callers that need to observe the pass (to drain it on shutdown, say) should
// branch on that null rather than assuming a promise.
export function createSingleFlight(): <T>(task: () => Promise<T>) => Promise<T> | null {
  let inFlight = false;
  return <T>(task: () => Promise<T>): Promise<T> | null => {
    if (inFlight) return null;
    inFlight = true;
    let started: Promise<T>;
    try {
      started = task();
    } catch (err) {
      // A task that throws synchronously never produces a promise to settle,
      // so release here or the latch would be stuck closed for the process
      // lifetime — a silent, permanent stall of the sweep.
      inFlight = false;
      throw err;
    }
    return started.finally(() => {
      inFlight = false;
    });
  };
}
