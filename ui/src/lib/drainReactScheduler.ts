/**
 * Runs the work React has already queued on its scheduler, while the test
 * environment still exists.
 *
 * React 19 schedules a passive-effect flush after every commit with passive
 * flags (a flushSync unmount included), and that task reads `window.event`
 * before anything else. In Node the scheduler posts it with setImmediate, and
 * immediates run in order, so awaiting our own turns runs everything queued
 * before the call. Three turns cover a task that yields and re-posts itself.
 *
 * Each turn also waits out one 0ms timer. Effect cleanups that run inside that
 * flush post their own `setTimeout(fn, 0)` -- Radix FocusScope dispatches its
 * unmount-autofocus `CustomEvent` that way -- and timers sit in a different
 * event-loop phase from immediates, so an immediates-only drain can return
 * before they fire. One firing after teardown builds Node's native CustomEvent
 * and jsdom rejects it ("parameter 1 is not of type 'Event'"), turning an
 * all-green run red (BLO-46894, master-health run 40149669920). Timers of equal
 * delay fire in insertion order, so ours runs after any posted before it.
 */
export async function drainReactScheduler(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
