import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../middleware/logger.js";
import { ACTION_SCOPED_SWEEP_NAMES, runActionScopedRecoverySweeps } from "./service.js";

/**
 * PEN-4094: the action-scoped recovery sweeps used to be awaited in a bare sequence
 * inside `reconcileIssueGraphLiveness`, so the first to throw abandoned the rest of the
 * tick. Each of them is itself a recovery backstop, and the sweep that runs first is
 * whichever was added most recently -- so the newest code could silence the oldest.
 *
 * `runActionScopedRecoverySweeps` is the one path production takes: the production call
 * site passes the real sweeps, these tests pass fakes. There is no second implementation
 * for the tests to drift from.
 */

/**
 * Records call order across every sweep so "the others still ran" is asserted on real
 * invocation evidence rather than on the returned value, which a half-working guard could
 * also produce.
 *
 * The fakes are keyed off `ACTION_SCOPED_SWEEP_NAMES` by the assertions below, so a sweep
 * added to that list without a fake here fails these tests rather than silently going
 * untested -- which is how PEN-3976's restored-execution discharge was caught.
 */
function createSweepSet(failing: { sweep?: string; error?: Error } = {}) {
  const calls: string[] = [];
  const make = (name: string, value: unknown) => async () => {
    calls.push(name);
    if (failing.sweep === name) throw failing.error ?? new Error(`${name} exploded`);
    return value;
  };
  return {
    calls,
    sweeps: {
      resolvedDependencyWakeBackstop: make("resolved_dependency_wake_backstop", { checked: 1 }),
      restoredExecutionRecoveryActions: make("restored_execution_recovery_actions", {
        discharged: 4,
      }),
      strandedRecoveryWakeBackstop: make("stranded_recovery_wake_backstop", { checked: 2 }),
      expiredRecoveryWakeHorizons: make("expired_recovery_wake_horizons", { escalated: 3 }),
    },
  };
}

describe("runActionScopedRecoverySweeps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs every sweep in order and reports no failures when none throw", async () => {
    const { calls, sweeps } = createSweepSet();

    const outcome = await runActionScopedRecoverySweeps(sweeps);

    expect(calls).toEqual([...ACTION_SCOPED_SWEEP_NAMES]);
    expect(outcome.failedSweeps).toEqual([]);
    expect(outcome.resolvedDependencyWakeBackstop).toEqual({ checked: 1 });
    expect(outcome.restoredExecutionRecoveryActions).toEqual({ discharged: 4 });
    expect(outcome.strandedRecoveryWakeBackstop).toEqual({ checked: 2 });
    expect(outcome.expiredRecoveryWakeHorizons).toEqual({ escalated: 3 });
  });

  // The regression proper. Without the guard this rejects instead of resolving, and the two
  // later sweeps are never invoked at all.
  it("keeps the later sweeps running when the first one throws", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    const { calls, sweeps } = createSweepSet({ sweep: "resolved_dependency_wake_backstop" });

    const outcome = await runActionScopedRecoverySweeps(sweeps);

    expect(calls).toEqual([...ACTION_SCOPED_SWEEP_NAMES]);
    expect(outcome.failedSweeps).toEqual(["resolved_dependency_wake_backstop"]);
    // The failed sweep yields null so its roll-up keeps its initialized zeros; the siblings
    // still carry their real results.
    expect(outcome.resolvedDependencyWakeBackstop).toBeNull();
    expect(outcome.restoredExecutionRecoveryActions).toEqual({ discharged: 4 });
    expect(outcome.strandedRecoveryWakeBackstop).toEqual({ checked: 2 });
    expect(outcome.expiredRecoveryWakeHorizons).toEqual({ escalated: 3 });
  });

  // Symmetry: the guard is not special-casing the sweep that happens to run first.
  it.each([...ACTION_SCOPED_SWEEP_NAMES])(
    "isolates %s without skipping the others",
    async (failingSweep) => {
      vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
      const { calls, sweeps } = createSweepSet({ sweep: failingSweep });

      const outcome = await runActionScopedRecoverySweeps(sweeps);

      expect(calls).toEqual([...ACTION_SCOPED_SWEEP_NAMES]);
      expect(outcome.failedSweeps).toEqual([failingSweep]);
    },
  );

  it("isolates every sweep independently when all of them throw", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    const calls: string[] = [];
    const boom = (name: string) => async (): Promise<never> => {
      calls.push(name);
      throw new Error(`${name} exploded`);
    };

    const outcome = await runActionScopedRecoverySweeps({
      resolvedDependencyWakeBackstop: boom("resolved_dependency_wake_backstop"),
      restoredExecutionRecoveryActions: boom("restored_execution_recovery_actions"),
      strandedRecoveryWakeBackstop: boom("stranded_recovery_wake_backstop"),
      expiredRecoveryWakeHorizons: boom("expired_recovery_wake_horizons"),
    });

    expect(calls).toEqual([...ACTION_SCOPED_SWEEP_NAMES]);
    expect(outcome.failedSweeps).toEqual([...ACTION_SCOPED_SWEEP_NAMES]);
  });

  // "Logged, not swallowed silently" is half the fix: `failedSweeps` names what did not run,
  // and the log line carries the error itself, which is the only place the cause survives.
  it("logs the failing sweep and the error that caused it", async () => {
    const error = new Error("stranded exploded");
    const logged = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    const { sweeps } = createSweepSet({ sweep: "stranded_recovery_wake_backstop", error });

    await runActionScopedRecoverySweeps(sweeps);

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]?.[0]).toMatchObject({
      err: error,
      sweep: "stranded_recovery_wake_backstop",
    });
  });

  // A non-Error rejection must not take a different path: the guard catches the value, not
  // an `instanceof Error`.
  it("isolates a sweep that rejects with a non-Error value", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    const calls: string[] = [];

    const outcome = await runActionScopedRecoverySweeps({
      resolvedDependencyWakeBackstop: async () => {
        calls.push("resolved_dependency_wake_backstop");
        // Deliberately not an Error: the guard must catch the rejected value itself
        // rather than keying on `instanceof Error`.
        throw "not an error";
      },
      restoredExecutionRecoveryActions: async () => {
        calls.push("restored_execution_recovery_actions");
        return { discharged: 4 };
      },
      strandedRecoveryWakeBackstop: async () => {
        calls.push("stranded_recovery_wake_backstop");
        return { checked: 2 };
      },
      expiredRecoveryWakeHorizons: async () => {
        calls.push("expired_recovery_wake_horizons");
        return { escalated: 3 };
      },
    });

    expect(calls).toEqual([...ACTION_SCOPED_SWEEP_NAMES]);
    expect(outcome.failedSweeps).toEqual(["resolved_dependency_wake_backstop"]);
    expect(outcome.strandedRecoveryWakeBackstop).toEqual({ checked: 2 });
  });
});
