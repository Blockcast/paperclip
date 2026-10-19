/**
 * Chain-level per-pass timing for the periodic heartbeat recovery chain (PEN-4381).
 *
 * WHY THIS EXISTS
 *
 * The recovery chain in `index.ts` is eight sequential passes. Only pass 1
 * (`reconcileStrandedAssignedIssues`) was instrumented — `pass-timing.ts`
 * measures *inside* it. Passes 2-8 had no timing at all, and the chain's own
 * gauge (`paperclip_heartbeat_recovery_chain_duration_seconds`) reports only
 * the total. So the difference between the two was the entire measurement:
 * subtract pass 1 from the chain and whatever is left is "passes 2-8", with no
 * way to say WHICH pass.
 *
 * That residual is not small and it did not stay still:
 *
 *   2026-09-29   chain dominated by pass 1 (1,761 s); passes 2-8 ~= 310 s
 *   2026-10-19   chain p50 135.6 s; pass 1 p50 54.6 s; passes 2-8 ~= 81 s
 *
 * i.e. after PEN-3636 took pass 1 down, the UNMEASURED part became 60% of the
 * chain. Three weeks of "the residual is about 81 seconds" was arithmetic on
 * two instruments that could not be joined, which is why this module exists
 * before any optimisation does.
 *
 * THE JOIN KEY IS THE POINT
 *
 * Every line carries `recoveryChainId` and `recoveryChainStartedAt`. Without
 * them the three instruments — the chain gauge, the pass-1 funnel line
 * (`stranded assigned issue sweep phase timing`) and these per-pass lines —
 * can only be correlated by timestamp proximity, which stops working exactly
 * when it matters: a chain that overruns its 30 s tick overlaps the next one's
 * log lines, and a slow chain is the case under investigation. `settle()`
 * re-emits the chain total under the same key so the per-pass durations can be
 * reconciled against it in the log alone, with the unlabelled gauge as the
 * cross-check rather than the only source.
 *
 * `unaccountedMs` on the settle line is the residual the passes do NOT explain
 * (promise-hop scheduling, event-loop queueing between `.then`s). It is
 * reported rather than assumed to be zero: a large value means the chain's cost
 * is not in any pass body, which is a different defect from a slow pass and
 * would otherwise be silently distributed across them by subtraction.
 *
 * WHY THE LINES ARE UNCONDITIONAL, AND EMITTED FROM A `finally`
 *
 * Both properties mirror `service.ts`'s `stranded assigned issue sweep phase
 * timing`, for the same two reasons:
 *
 *   - `finally`, because a pass that THROWS is the one most worth diagnosing,
 *     and the chain's error boundary is a single `.catch` at the very end —
 *     so a throw in pass 3 would otherwise discard pass 3's wall clock
 *     entirely and silently skip passes 4-8.
 *   - unconditional, because a FAST pass is exactly the observation the slow
 *     ones have to be compared against. Gating on "something happened" leaves
 *     only the expensive passes in the log and makes the comparison
 *     impossible.
 *
 * Every log call here is wrapped in a BARE catch. A `finally` that throws
 * REPLACES the error unwinding through it, so a diagnostic failure would mask
 * the fault it exists to explain. Logging the failure instead would re-throw
 * from the same place, so swallowing is the only branch that delivers the
 * guarantee. This module is diagnostic only: it is on no decision path, and
 * `time()` is transparent to both the resolved value and the thrown error.
 */
import { randomUUID } from "node:crypto";

export const RECOVERY_CHAIN_PASS_TIMING_MESSAGE = "periodic heartbeat recovery pass timing";
export const RECOVERY_CHAIN_TIMING_MESSAGE = "periodic heartbeat recovery chain timing";

export type RecoveryChainPassOutcome = "ok" | "failed";

export interface RecoveryChainPassRecord {
  passIndex: number;
  pass: string;
  durationMs: number;
  outcome: RecoveryChainPassOutcome;
}

export interface RecoveryChainTimer {
  readonly chainId: string;
  readonly startedAtMs: number;
  /**
   * Runs `run()`, emitting one unconditional duration line for it. Transparent:
   * resolves with `run()`'s value and re-throws its error unchanged.
   */
  time<T>(passIndex: number, pass: string, run: () => Promise<T>): Promise<T>;
  /**
   * `time()` curried for use directly as a `.then()` argument, so wiring a pass
   * into the chain does not re-indent its body — which keeps the diff on an
   * eight-pass chain reviewable.
   */
  pass<T>(passIndex: number, pass: string, run: () => Promise<T>): () => Promise<T>;
  /**
   * Emits the chain-level reconciliation line. Call once, from the chain's
   * `finally`. Never throws.
   */
  settle(chainDurationMs: number): void;
}

export interface RecoveryChainTimerOptions {
  log: (fields: Record<string, unknown>, message: string) => void;
  /** Injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable for tests. Defaults to a fresh UUID per chain. */
  chainId?: string;
}

export function createRecoveryChainTimer(opts: RecoveryChainTimerOptions): RecoveryChainTimer {
  const now = opts.now ?? Date.now;
  const chainId = opts.chainId ?? randomUUID();
  const startedAtMs = now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const passes: RecoveryChainPassRecord[] = [];

  // `Math.max(0, ...)` on every elapsed value: a backwards clock must not put a
  // negative duration on a field that only ever means "how long did this take".
  // Same guard the chain gauge already applies to its own total.
  const elapsedSince = (fromMs: number): number => Math.max(0, now() - fromMs);

  const joinKey = (): Record<string, unknown> => ({
    recoveryChainId: chainId,
    recoveryChainStartedAt: startedAtIso,
  });

  // Named rather than an object-literal method so `pass()` can reference it
  // without `this` — the timer is passed around and destructured, and a `this`
  // binding would turn that into a runtime TypeError on a diagnostic path.
  async function time<T>(passIndex: number, pass: string, run: () => Promise<T>): Promise<T> {
    const passStartedAtMs = now();
    let outcome: RecoveryChainPassOutcome = "ok";
    try {
      return await run();
    } catch (err) {
      outcome = "failed";
      throw err;
    } finally {
      const record: RecoveryChainPassRecord = {
        passIndex,
        pass,
        durationMs: elapsedSince(passStartedAtMs),
        outcome,
      };
      // Recorded before the log call, and outside its try, so a transport
      // failure costs one line rather than also dropping the pass from the
      // settle line's reconciliation.
      passes.push(record);
      try {
        opts.log({ ...joinKey(), ...record }, RECOVERY_CHAIN_PASS_TIMING_MESSAGE);
      } catch {
        // Intentionally empty — see the module docblock.
      }
    }
  }

  return {
    chainId,
    startedAtMs,
    time,
    pass<T>(passIndex: number, pass: string, run: () => Promise<T>): () => Promise<T> {
      return () => time(passIndex, pass, run);
    },
    settle(chainDurationMs: number): void {
      try {
        const passDurationMsTotal = passes.reduce((total, p) => total + p.durationMs, 0);
        const boundedChainDurationMs = Math.max(0, chainDurationMs);
        opts.log(
          {
            ...joinKey(),
            chainDurationMs: boundedChainDurationMs,
            passDurationMsTotal,
            // Can legitimately be negative if the chain total was captured
            // before the last pass's `finally` ran; reported as measured rather
            // than clamped, because a negative value here means the two clocks
            // disagree and clamping would hide that.
            unaccountedMs: boundedChainDurationMs - passDurationMsTotal,
            passesRun: passes.length,
            passesFailed: passes.filter((p) => p.outcome === "failed").length,
            passes,
          },
          RECOVERY_CHAIN_TIMING_MESSAGE,
        );
      } catch {
        // Intentionally empty — see the module docblock.
      }
    },
  };
}
