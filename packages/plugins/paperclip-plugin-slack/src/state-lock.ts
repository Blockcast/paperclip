/**
 * Serializes read-modify-write sequences against a single plugin-state key.
 *
 * `ctx.state` exposes only `get` / `set` / `delete` — there is no
 * compare-and-swap and no atomic increment. So the natural
 * `const v = await state.get(k); await state.set(k, v + 1)` shape is a lost
 * update waiting to happen: every `await` is a yield point, so two handlers
 * for the same key both read the old value and the second `set` silently
 * overwrites the first (BLO-23143, Ally findings 2 and 3 on
 * Blockcast/paperclip#996).
 *
 * `withStateLock` chains callers for the same `lockKey` so each one observes
 * the previous writer's result. Callers for *different* keys are untouched and
 * still run concurrently.
 *
 * Scope, stated plainly: this serializes within one worker process only. It is
 * the strongest guarantee available on top of a get/set state API, and it
 * covers the failure these findings describe — a single Slack worker fanning
 * many event handlers and a scheduled job over the same company key. Two
 * worker replicas writing the same key would still race; closing that needs an
 * atomic primitive in the state API itself, not a fix in this plugin.
 */
const chains = new Map<string, Promise<unknown>>();

export function withStateLock<T>(
  lockKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(lockKey) ?? Promise.resolve();
  // Run `fn` whether the previous holder resolved or rejected: one caller's
  // failure must not wedge the key for everyone behind it.
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(lockKey, settled);
  // Keep the map bounded: drop the entry once this caller is the tail and has
  // finished, so a long-lived worker does not retain one promise per company
  // per day forever.
  void settled.then(() => {
    if (chains.get(lockKey) === settled) chains.delete(lockKey);
  });
  return run;
}

/**
 * Number of lock keys with an unsettled chain.
 *
 * Exported for the bounded-map regression: `withStateLock` drops a key once its
 * tail settles, and a refactor that stopped doing so would leak one promise per
 * company per day in a long-lived worker with no visible symptom.
 */
export function pendingLockKeyCount(): number {
  return chains.size;
}

/** Lock key for a company's `recent-watch-events` queue. */
export const watchQueueLockKey = (companyId: string): string =>
  `watch-queue:${companyId}`;

/** Lock key for a company's daily cost accumulators for one date. */
export const costAccumulatorLockKey = (
  companyId: string,
  dateKey: string,
): string => `daily-cost:${companyId}:${dateKey}`;
