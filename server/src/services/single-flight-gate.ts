/**
 * Re-entrancy gate for fire-and-forget work launched from a fixed-interval timer.
 *
 * A `setInterval` fires on a wall clock, not on completion. Work launched from
 * one and not awaited by it therefore overlaps itself the moment a pass takes
 * longer than the interval — and because each overlapping pass holds its own
 * inputs alive, the overlap is not merely wasted CPU, it is retained heap.
 *
 * That is the mechanism behind PEN-3314. The paperclip worker's periodic
 * recovery chain materializes the whole visible issue graph (issues, relations,
 * agents, runs, wake requests, interactions, approvals — profiled at 40k issues
 * in BLO-33225) and then awaits per-finding database work while holding it. With
 * a 30 s interval and no gate, a chain that runs long stacks on its predecessor,
 * each copy pinning a fresh graph. Worse, the passes contend for one 10-connection
 * pool (`POSTGRES_POOL_MAX`), whose wait queue is unbounded, so every extra
 * concurrent pass slows every other one — overlap feeds itself. Measured on the
 * production worker: old-space heap tracked pool wait-queue depth at ~10 MB per
 * queued query across seven consecutive container generations, climbing to the
 * 6.2 GB V8 ceiling in 5-7 h and aborting.
 *
 * Skipping a tick is safe for this class of work and is the point: these passes
 * are reconcilers, so a skipped tick is not lost work, only later work. What is
 * NOT safe is a gate that wedges — a flag left set would silently stop recovery
 * fleet-wide, which is a worse failure than the leak it prevents. The flag is
 * therefore cleared on every exit path, including a synchronous throw from
 * `start` (see the test file), and the gate holds no reference to the work once
 * it settles.
 */
export type SingleFlightGate = {
  /** True while a pass launched through {@link SingleFlightGate.run} is outstanding. */
  readonly busy: boolean;
  /**
   * Launch `start` unless a previous pass is still outstanding.
   *
   * Returns the tracking promise for the launched pass, or `null` when the call
   * was skipped because the gate was busy. `null` is deliberately distinct from
   * a resolved promise so a caller can tell "skipped" from "ran and finished"
   * — the shutdown drain must not be handed a promise for work that never
   * started.
   */
  run(start: () => Promise<unknown>): Promise<void> | null;
};

export type SingleFlightGateHooks = {
  /** Called once per skipped tick, before `run` returns `null`. */
  readonly onSkip?: () => void;
  /** Called once per completed pass, on success and on failure alike. */
  readonly onSettled?: (durationMs: number) => void;
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number;
};

export function createSingleFlightGate(hooks: SingleFlightGateHooks = {}): SingleFlightGate {
  const now = hooks.now ?? (() => Date.now());
  let inFlight = false;

  const settle = (startedAtMs: number) => {
    inFlight = false;
    // A backwards clock must not produce a negative duration on a metric that
    // only ever means "how long did this take".
    hooks.onSettled?.(Math.max(0, now() - startedAtMs));
  };

  return {
    get busy() {
      return inFlight;
    },
    run(start) {
      if (inFlight) {
        hooks.onSkip?.();
        return null;
      }
      inFlight = true;
      const startedAtMs = now();

      let work: Promise<unknown>;
      try {
        work = Promise.resolve(start());
      } catch (err) {
        // `start` threw before returning a promise. Clear the gate here or it
        // stays set forever and every subsequent tick is skipped.
        settle(startedAtMs);
        return Promise.reject(err);
      }

      return work.then(
        () => {
          settle(startedAtMs);
        },
        (err) => {
          settle(startedAtMs);
          throw err;
        },
      );
    },
  };
}
