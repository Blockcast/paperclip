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
 * the process. That failure is quieter than the one this gate replaces and
 * therefore worse: pre-gate, a stuck chain grew the heap to the V8 ceiling and
 * the worker aborted, which was destructive but self-clearing, whereas a wedged
 * gate leaves a process that looks perfectly healthy — flat heap, no restart —
 * while orphan reaping, scheduled-retry promotion, stranded-issue reconciliation,
 * watchdogs and every other pass in the chain are stopped indefinitely.
 *
 * {@link SingleFlightGateOptions.stallCeilingMs} bounds that. Once a pass has
 * been outstanding for longer than the ceiling, the next tick abandons the
 * GATE — not the work, which is unawaitable by construction and may still be
 * holding a connection — reports it through
 * {@link SingleFlightGateOptions.onStalled}, and is admitted. Two properties
 * make that safe to do:
 *
 *   - It cannot recreate the incident. The ceiling is a large multiple of the
 *     tick interval, so overlap accrues at one extra pass per ceiling rather
 *     than one per tick. A merely slow chain — the actual production failure,
 *     which was pool contention rather than a hang — is never abandoned.
 *   - An abandoned pass that settles late cannot corrupt the replacement. Each
 *     pass carries its own identity and `settle` is a no-op for any pass that no
 *     longer owns the gate, so a stalled chain returning an hour later does not
 *     clear a flag set by a live successor.
 *
 * The ceiling is opt-in (`0`/unset disables it) so a caller that genuinely wants
 * unbounded single-flight semantics still gets them.
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
   * Called when a tick abandons the gate because the outstanding pass exceeded
   * {@link SingleFlightGateOptions.stallCeilingMs}, with that pass's elapsed
   * time. The abandoned work is NOT cancelled — it is unawaitable by
   * construction — so this reports a pass that is still running somewhere, not
   * one that ended.
   */
  readonly onStalled?: (elapsedMs: number) => void;
  /**
   * Abandon the gate once a pass has been outstanding this long, admitting the
   * next tick. `0` or unset disables the ceiling entirely.
   *
   * Size it as a large multiple of the caller's tick interval. Too low
   * reintroduces the self-overlap the gate exists to prevent, for a chain that
   * is slow but making progress; the ceiling is for a chain that is not coming
   * back.
   */
  readonly stallCeilingMs?: number;
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number;
};

/** One outstanding pass. Identity is the point — see `settle`. */
type Pass = { readonly startedAtMs: number };

export function createSingleFlightGate(options: SingleFlightGateOptions = {}): SingleFlightGate {
  const now = options.now ?? (() => Date.now());
  const stallCeilingMs = options.stallCeilingMs ?? 0;
  let current: Pass | null = null;

  const settle = (pass: Pass) => {
    // A pass abandoned at the stall ceiling can still settle, arbitrarily late.
    // It no longer owns the gate, so clearing here would release a flag that a
    // live replacement set — reopening the overlap this gate prevents. Compare
    // identity rather than a boolean.
    if (current !== pass) return;
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
        if (stallCeilingMs <= 0 || elapsedMs < stallCeilingMs) {
          options.onSkip?.(elapsedMs);
          return null;
        }
        // Past the ceiling. Abandon the gate so recovery resumes; the work
        // itself keeps running (nothing here can cancel it) and its late settle
        // is ignored by the identity check in `settle`. Resetting `current` here
        // also resets the clock, so the next abandonment cannot happen sooner
        // than a further `stallCeilingMs` — that is what bounds the overlap rate
        // to one extra pass per ceiling rather than one per tick.
        current = null;
        options.onStalled?.(elapsedMs);
      }

      const pass: Pass = { startedAtMs: now() };
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
