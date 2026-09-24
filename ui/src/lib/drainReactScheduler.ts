/**
 * Runs the work React has already queued on its scheduler, while the test
 * environment still exists.
 *
 * React 19 schedules a passive-effect flush after every commit with passive
 * flags (a flushSync unmount included), and that task reads `window.event`
 * before anything else. In Node the scheduler posts it with setImmediate, and
 * immediates run in order, so awaiting our own turns runs everything queued
 * before the call. Three turns cover a task that yields and re-posts itself.
 */
export async function drainReactScheduler(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}
