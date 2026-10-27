import { describe, expect, it, vi } from "vitest";
import {
  RECOVERY_CHAIN_PASS_TIMING_MESSAGE,
  RECOVERY_CHAIN_TIMING_MESSAGE,
  createRecoveryChainTimer,
} from "./chain-pass-timing.js";

type Line = { fields: Record<string, unknown>; message: string };

function harness(options: { now?: () => number; log?: (f: Record<string, unknown>, m: string) => void } = {}) {
  const lines: Line[] = [];
  const log = options.log ?? ((fields: Record<string, unknown>, message: string) => {
    lines.push({ fields, message });
  });
  const timer = createRecoveryChainTimer({ log, now: options.now, chainId: "chain-1" });
  return { lines, timer };
}

/** A clock the test advances explicitly, so durations are exact rather than wall-clock-flaky. */
function fakeClock(startMs: number) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("createRecoveryChainTimer", () => {
  it("emits one unconditional pass line per pass, carrying the join key", async () => {
    const clock = fakeClock(1_700_000_000_000);
    const { lines, timer } = harness({ now: clock.now });

    await timer.time(2, "reconcileIssueGraphLiveness", async () => {
      clock.advance(1_500);
    });
    await timer.time(3, "reconcileTaskWatchdogs", async () => {
      clock.advance(400);
    });

    const passLines = lines.filter((l) => l.message === RECOVERY_CHAIN_PASS_TIMING_MESSAGE);
    expect(passLines).toHaveLength(2);
    expect(passLines[0].fields).toMatchObject({
      recoveryChainId: "chain-1",
      recoveryChainStartedAt: new Date(1_700_000_000_000).toISOString(),
      passIndex: 2,
      pass: "reconcileIssueGraphLiveness",
      durationMs: 1_500,
      outcome: "ok",
    });
    expect(passLines[1].fields).toMatchObject({ passIndex: 3, durationMs: 400, outcome: "ok" });
  });

  it("emits a line for a pass that does no work, so fast passes stay comparable", async () => {
    const clock = fakeClock(0);
    const { lines, timer } = harness({ now: clock.now });

    await timer.time(6, "reconcileResolvedBlockerDependents", async () => {
      // Deliberately no work and no state change: the gating bug this guards
      // against is "only log when something happened", which would erase the
      // baseline the slow passes are compared against.
    });

    expect(lines.filter((l) => l.message === RECOVERY_CHAIN_PASS_TIMING_MESSAGE)).toHaveLength(1);
    expect(lines[0].fields).toMatchObject({ passIndex: 6, durationMs: 0, outcome: "ok" });
  });

  it("times and logs a throwing pass, re-throwing the original error unchanged", async () => {
    const clock = fakeClock(0);
    const { lines, timer } = harness({ now: clock.now });
    const boom = new Error("pool timeout");

    await expect(
      timer.time(4, "scanSilentActiveRuns", async () => {
        clock.advance(2_750);
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(lines).toHaveLength(1);
    expect(lines[0].fields).toMatchObject({
      passIndex: 4,
      pass: "scanSilentActiveRuns",
      durationMs: 2_750,
      outcome: "failed",
    });
  });

  it("resolves with the pass's own value", async () => {
    const { timer } = harness();
    await expect(timer.time(5, "reconcileProductivityReviews", async () => ({ created: 3 }))).resolves.toEqual({
      created: 3,
    });
  });

  it("reconciles the chain total against the passes it ran", async () => {
    const clock = fakeClock(0);
    const { lines, timer } = harness({ now: clock.now });

    await timer.time(1, "reconcileStrandedAssignedIssues", async () => {
      clock.advance(54_600);
    });
    await timer.time(2, "reconcileIssueGraphLiveness", async () => {
      clock.advance(20_000);
    });
    // 5 s of the chain sits outside any pass body — promise-hop scheduling.
    clock.advance(5_000);
    timer.settle(79_600);

    const settle = lines.find((l) => l.message === RECOVERY_CHAIN_TIMING_MESSAGE);
    expect(settle?.fields).toMatchObject({
      recoveryChainId: "chain-1",
      chainDurationMs: 79_600,
      passDurationMsTotal: 74_600,
      unaccountedMs: 5_000,
      passesRun: 2,
      passesFailed: 0,
    });
    expect(settle?.fields.passes).toEqual([
      { passIndex: 1, pass: "reconcileStrandedAssignedIssues", durationMs: 54_600, outcome: "ok" },
      { passIndex: 2, pass: "reconcileIssueGraphLiveness", durationMs: 20_000, outcome: "ok" },
    ]);
  });

  it("counts a failed pass in the settle line, and reports the passes the chain never reached", async () => {
    const clock = fakeClock(0);
    const { lines, timer } = harness({ now: clock.now });

    await timer.time(1, "reconcileStrandedAssignedIssues", async () => {
      clock.advance(1_000);
    });
    await expect(
      timer.time(2, "reconcileIssueGraphLiveness", async () => {
        clock.advance(500);
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    timer.settle(1_500);

    const settle = lines.find((l) => l.message === RECOVERY_CHAIN_TIMING_MESSAGE);
    // passesRun is 2 of the chain's 8: the six the throw skipped are absent,
    // which is the signal that the chain was truncated rather than quiet.
    expect(settle?.fields).toMatchObject({ passesRun: 2, passesFailed: 1, unaccountedMs: 0 });
  });

  it("never lets a logging failure escape, in either emitter", async () => {
    const log = vi.fn(() => {
      throw new Error("transport down");
    });
    const timer = createRecoveryChainTimer({ log, chainId: "chain-1" });

    // A `finally` that throws would REPLACE the pass's real error; assert the
    // real one survives.
    await expect(
      timer.time(3, "reconcileTaskWatchdogs", async () => {
        throw new Error("real failure");
      }),
    ).rejects.toThrow("real failure");
    await expect(timer.time(4, "scanSilentActiveRuns", async () => "ok")).resolves.toBe("ok");
    expect(() => timer.settle(10)).not.toThrow();
    expect(log).toHaveBeenCalledTimes(3);
  });

  it("keeps a pass in the reconciliation even when its own line failed to emit", async () => {
    const calls: Line[] = [];
    let failNext = true;
    const log = (fields: Record<string, unknown>, message: string) => {
      if (failNext) {
        failNext = false;
        throw new Error("transport blip");
      }
      calls.push({ fields, message });
    };
    const clock = fakeClock(0);
    const timer = createRecoveryChainTimer({ log, now: clock.now, chainId: "chain-1" });

    await timer.time(2, "reconcileIssueGraphLiveness", async () => {
      clock.advance(900);
    });
    timer.settle(900);

    const settle = calls.find((l) => l.message === RECOVERY_CHAIN_TIMING_MESSAGE);
    expect(settle?.fields).toMatchObject({ passesRun: 1, passDurationMsTotal: 900 });
  });

  it("pass() is time() curried for `.then`, and survives being detached from the timer", async () => {
    const clock = fakeClock(0);
    const { lines, timer } = harness({ now: clock.now });
    // Detached on purpose: this is exactly how the chain uses it
    // (`.then(chainTimer.pass(...))`), and a `this`-bound implementation would
    // pass the attached call below and still throw in production.
    const { pass } = timer;

    await Promise.resolve().then(
      pass(2, "reconcileIssueGraphLiveness", async () => {
        clock.advance(700);
        return "done";
      }),
    );
    timer.settle(700);

    expect(lines[0].fields).toMatchObject({ passIndex: 2, durationMs: 700, outcome: "ok" });
    const settle = lines.find((l) => l.message === RECOVERY_CHAIN_TIMING_MESSAGE);
    expect(settle?.fields).toMatchObject({ passesRun: 1, passDurationMsTotal: 700 });
  });

  it("does not start a pass until the returned thunk is invoked", async () => {
    const { timer } = harness();
    const run = vi.fn(async () => undefined);
    const thunk = timer.pass(3, "reconcileTaskWatchdogs", run);
    expect(run).not.toHaveBeenCalled();
    await thunk();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("gives each chain a distinct id when none is supplied", () => {
    const log = () => {};
    const first = createRecoveryChainTimer({ log });
    const second = createRecoveryChainTimer({ log });
    expect(first.chainId).not.toBe(second.chainId);
  });

  it("never reports a negative pass duration when the clock goes backwards", async () => {
    let current = 10_000;
    const { lines, timer } = harness({ now: () => current });
    await timer.time(7, "reconcileFailedWakeDispatches", async () => {
      current = 9_000;
    });
    expect(lines[0].fields).toMatchObject({ durationMs: 0 });
  });

  it("skips passes reached after shouldSkip turns true (BLO-49596)", async () => {
    let stopped = false;
    const ran: string[] = [];
    const timer = createRecoveryChainTimer({ log: () => undefined, chainId: "chain-1", shouldSkip: () => stopped });
    await timer
      .time(1, "one", async () => { ran.push("one"); stopped = true; })
      .then(timer.pass(2, "two", async () => { ran.push("two"); }));
    expect(ran).toEqual(["one"]);
  });
});
