import { describe, expect, it, vi } from "vitest";
import { createSingleFlightGate } from "../services/single-flight-gate.js";

/**
 * PEN-3314. The gate exists to stop the worker's 30 s recovery chain stacking on
 * itself, but the failure mode to guard hardest against is the gate WEDGING: a
 * flag left set silently stops fleet-wide recovery forever, which is strictly
 * worse than the leak it prevents. Every exit path is covered below.
 */
describe("createSingleFlightGate", () => {
  const deferred = () => {
    let resolve!: (value?: unknown) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res as (value?: unknown) => void;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it("runs the first pass and reports busy until it settles", async () => {
    const gate = createSingleFlightGate();
    const first = deferred();

    expect(gate.busy).toBe(false);
    const tracked = gate.run(() => first.promise);
    expect(tracked).not.toBeNull();
    expect(gate.busy).toBe(true);

    first.resolve();
    await tracked;
    expect(gate.busy).toBe(false);
  });

  it("skips a tick while a pass is outstanding and does not invoke the work", async () => {
    const onSkip = vi.fn();
    const gate = createSingleFlightGate({ onSkip });
    const first = deferred();
    const secondStart = vi.fn(async () => undefined);

    const tracked = gate.run(() => first.promise);
    const skipped = gate.run(secondStart);

    // `null` rather than a resolved promise: the caller must be able to tell
    // "skipped" from "ran and finished" so it does not hand the shutdown drain a
    // promise for work that never started.
    expect(skipped).toBeNull();
    expect(secondStart).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledTimes(1);

    first.resolve();
    await tracked;
  });

  it("admits the next pass once the previous one resolves", async () => {
    const gate = createSingleFlightGate();
    const first = deferred();
    const tracked = gate.run(() => first.promise);
    first.resolve();
    await tracked;

    const secondStart = vi.fn(async () => undefined);
    const second = gate.run(secondStart);
    expect(second).not.toBeNull();
    expect(secondStart).toHaveBeenCalledTimes(1);
    await second;
  });

  it("clears the gate when the pass REJECTS, so a failing chain cannot wedge recovery", async () => {
    const gate = createSingleFlightGate();
    const failure = new Error("chain blew up");

    const tracked = gate.run(async () => {
      throw failure;
    });
    await expect(tracked).rejects.toThrow("chain blew up");
    expect(gate.busy).toBe(false);

    // The very next tick must be admitted.
    const next = vi.fn(async () => undefined);
    await gate.run(next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("clears the gate when `start` throws SYNCHRONOUSLY, before returning a promise", async () => {
    const gate = createSingleFlightGate();
    const failure = new Error("threw before awaiting");

    const tracked = gate.run(() => {
      throw failure;
    });

    // A synchronous throw never produces the promise the gate would otherwise
    // hang its cleanup on. Without the explicit try/catch this is the case that
    // leaves the flag set forever.
    await expect(tracked).rejects.toThrow("threw before awaiting");
    expect(gate.busy).toBe(false);

    const next = vi.fn(async () => undefined);
    await gate.run(next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("reports settle duration on success and on failure alike", async () => {
    const onSettled = vi.fn();
    let clock = 1_000;
    const gate = createSingleFlightGate({ onSettled, now: () => clock });

    const first = deferred();
    const tracked = gate.run(() => first.promise);
    clock = 31_500;
    first.resolve();
    await tracked;
    expect(onSettled).toHaveBeenNthCalledWith(1, 30_500);

    clock = 40_000;
    const failed = gate.run(async () => {
      throw new Error("nope");
    });
    await expect(failed).rejects.toThrow("nope");
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(onSettled.mock.calls[1]?.[0]).toBe(0);
  });

  it("never reports a negative duration if the clock goes backwards", async () => {
    const onSettled = vi.fn();
    let clock = 5_000;
    const gate = createSingleFlightGate({ onSettled, now: () => clock });

    const first = deferred();
    const tracked = gate.run(() => first.promise);
    clock = 4_000;
    first.resolve();
    await tracked;

    expect(onSettled).toHaveBeenCalledWith(0);
  });

  it("serializes a long run of overlapping ticks to one pass at a time", async () => {
    const onSkip = vi.fn();
    const gate = createSingleFlightGate({ onSkip });
    let concurrent = 0;
    let maxConcurrent = 0;
    let completed = 0;

    const pending: Array<Promise<void> | null> = [];
    const gates: Array<ReturnType<typeof deferred>> = [];

    // Twenty ticks arrive while the first pass is still outstanding.
    for (let tick = 0; tick < 20; tick += 1) {
      pending.push(
        gate.run(() => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          const control = deferred();
          gates.push(control);
          return control.promise.then(() => {
            concurrent -= 1;
            completed += 1;
          });
        }),
      );
    }

    expect(gates).toHaveLength(1);
    gates[0]?.resolve();
    await Promise.all(pending.filter(Boolean));

    expect(maxConcurrent).toBe(1);
    expect(completed).toBe(1);
    expect(onSkip).toHaveBeenCalledTimes(19);
    expect(pending.filter((entry) => entry === null)).toHaveLength(19);
  });
});
