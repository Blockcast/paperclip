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
 *
 * Clearing on every exit path is necessary but NOT sufficient, because all three
 * of those paths require the pass to *finish*. A pass that simply never settles
 * — a chain awaiting a database query that never returns — holds the flag with
 * no cleanup path to reach, and every subsequent tick is skipped for the life of
 * the process. That state is quieter than the failure this gate replaces and so
 * worse in character: pre-gate, a stuck chain grew the heap to the V8 ceiling
 * and the worker aborted, which was destructive but self-clearing, whereas a
 * wedged gate leaves a process that looks perfectly healthy — flat heap, no
 * restart — while orphan reaping, scheduled-retry promotion, stranded-issue
 * reconciliation, watchdogs and every other pass in the chain are stopped
 * indefinitely.
 *
 * {@link SingleFlightGateOptions.stallAfterMs} makes that state **loud**. Once a
 * pass has been outstanding longer than the threshold, the next skipped tick
 * reports it — once per pass — through
 * {@link SingleFlightGateOptions.onStalled}. The tick is still skipped.
 *
 * **The gate deliberately does NOT clear itself and admit the next tick.** That
 * was considered and declined (PEN-3365): force-clearing re-admits exactly the
 * overlapping passes this gate exists to remove, under precisely the conditions
 * that would have triggered the watchdog — a saturated pool — so the self-heal
 * would reintroduce the heap leak at the moment the system is least able to
 * absorb it. A stall you can page on is the goal; a stall that quietly reopens
 * the leak is not. **Alert, do not self-heal.**
 *
 * The durable fix for the underlying hang is a bounded statement/connection
 * timeout on the pool, which removes the mechanism at source rather than
 * reacting to it. `stallAfterMs` is the detector, not the cure.
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

export type SingleFlightGateOptions = {
  /**
   * Called once per skipped tick, before `run` returns `null`, with how long the
   * outstanding pass has been running.
   *
   * The elapsed time is an argument because without it a skip is unactionable:
   * during an incident the alternative is an identical, context-free line every
   * tick, with no way to tell "the chain is taking 35 s" from "the chain has
   * been wedged for six hours" — which is the distinction that decides whether
   * to page.
   */
  readonly onSkip?: (elapsedMs: number) => void;
  /** Called once per completed pass, on success and on failure alike. */
  readonly onSettled?: (durationMs: number) => void;
  /**
   * Called at most ONCE per pass, the first time a skipped tick observes that
   * pass outstanding for longer than {@link SingleFlightGateOptions.stallAfterMs}.
   *
   * Once per pass rather than once per tick so the signal counts distinct
   * wedges rather than re-counting one wedge every interval forever. The pass is
   * still running and the gate is still held when this fires — nothing here
   * cancels or clears anything.
   */
  readonly onStalled?: (elapsedMs: number) => void;
  /**
   * Report a pass still outstanding after this long. `0` or unset disables the
   * report. Detection only — the gate stays held either way.
   *
   * Size it as a large multiple of the caller's tick interval: a chain that is
   * slow but progressing is an ordinary skip, and calling that a stall would
   * page on the healthy-but-degraded case this gate is designed to absorb.
   */
  readonly stallAfterMs?: number;
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number;
};

/** One outstanding pass. `stallReported` latches the once-per-pass `onStalled`. */
type Pass = { readonly startedAtMs: number; stallReported: boolean };

export function createSingleFlightGate(options: SingleFlightGateOptions = {}): SingleFlightGate {
  const now = options.now ?? (() => Date.now());
  const stallAfterMs = options.stallAfterMs ?? 0;
  let current: Pass | null = null;

  const settle = (pass: Pass) => {
    current = null;
    // A backwards clock must not produce a negative duration on a metric that
    // only ever means "how long did this take".
    options.onSettled?.(Math.max(0, now() - pass.startedAtMs));
  };

  return {
    get busy() {
      return current !== null;
    },
    run(start) {
      const outstanding = current;
      if (outstanding) {
        const elapsedMs = Math.max(0, now() - outstanding.startedAtMs);
        if (stallAfterMs > 0 && !outstanding.stallReported && elapsedMs >= stallAfterMs) {
          // Latch before the callback: a throwing hook must not re-arm the
          // report and turn a once-per-pass signal into a once-per-tick one.
          outstanding.stallReported = true;
          options.onStalled?.(elapsedMs);
        }
        options.onSkip?.(elapsedMs);
        return null;
      }

      const pass: Pass = { startedAtMs: now(), stallReported: false };
      current = pass;

      let work: Promise<unknown>;
      try {
        work = Promise.resolve(start());
      } catch (err) {
        // `start` threw before returning a promise. Clear the gate here or it
        // stays set forever and every subsequent tick is skipped.
        settle(pass);
        return Promise.reject(err);
      }

      return work.then(
        () => {
          settle(pass);
        },
        (err) => {
          settle(pass);
          throw err;
        },
      );
    },
  };
}
