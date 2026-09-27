import { describe, expect, it, vi } from "vitest";
import { createSingleFlightGate } from "../services/single-flight-gate.js";

/**
 * PEN-3314. The gate exists to stop the worker's 30 s recovery chain stacking on
 * itself, but the failure mode to guard hardest against is the gate WEDGING: a
 * flag left set silently stops fleet-wide recovery forever, which is strictly
 * worse than the leak it prevents.
 *
 * Two independent ways the flag can be left set, and both are covered below:
 *   - a missing cleanup path, so a pass that DID finish never cleared it — the
 *     resolve/reject/synchronous-throw cases;
 *   - a pass that never finishes at all, so no cleanup path is reachable in the
 *     first place — the stall-reporting cases. These are not the same bug and
 *     the first set of tests says nothing about the second.
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
    let clock = 1_000;
    const gate = createSingleFlightGate({ onSkip, now: () => clock });
    const first = deferred();
    const secondStart = vi.fn(async () => undefined);

    const tracked = gate.run(() => first.promise);
    clock = 41_000;
    const skipped = gate.run(secondStart);

    // `null` rather than a resolved promise: the caller must be able to tell
    // "skipped" from "ran and finished" so it does not hand the shutdown drain a
    // promise for work that never started.
    expect(skipped).toBeNull();
    expect(secondStart).not.toHaveBeenCalled();
    // The elapsed time is reported, not just the fact of a skip — without it an
    // operator cannot tell a slow chain from a wedged one.
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledWith(40_000);

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

  /**
   * The pass that never settles. None of the exit paths above are reachable
   * here, so the flag is held for the life of the process and every recovery
   * pass on the worker stops — with a flat heap and no restart to show for it.
   *
   * The gate REPORTS that state and deliberately does NOT clear it (PEN-3365);
   * see the "does not self-clear" case below for why that is the point rather
   * than an omission.
   */
  describe("stall reporting", () => {
    it("reports a pass outstanding past the threshold, once, with its elapsed time", async () => {
      const onStalled = vi.fn();
      const onSkip = vi.fn();
      let clock = 1_000;
      const gate = createSingleFlightGate({
        onSkip,
        onStalled,
        stallAfterMs: 600_000,
        now: () => clock,
      });

      gate.run(() => deferred().promise);

      // Below the threshold this is an ordinary skip, however close it gets.
      clock = 1_000 + 599_999;
      expect(gate.run(async () => undefined)).toBeNull();
      expect(onStalled).not.toHaveBeenCalled();
      expect(onSkip).toHaveBeenCalledWith(599_999);

      clock = 1_000 + 600_000;
      expect(gate.run(async () => undefined)).toBeNull();
      expect(onStalled).toHaveBeenCalledTimes(1);
      expect(onStalled).toHaveBeenCalledWith(600_000);

      // Once per PASS, not once per tick: a six-hour wedge must count as one
      // stall, not as 720 of them.
      for (let tick = 1; tick <= 20; tick += 1) {
        clock = 1_000 + 600_000 + tick * 30_000;
        gate.run(async () => undefined);
      }
      expect(onStalled).toHaveBeenCalledTimes(1);
      // ...while the skip signal keeps firing every tick, so the elapsed time
      // an operator reads stays current.
      expect(onSkip).toHaveBeenCalledTimes(22);
      expect(onSkip).toHaveBeenLastCalledWith(600_000 + 20 * 30_000);
    });

    it("does NOT self-clear: the stalled pass keeps the gate held (PEN-3365)", async () => {
      // The load-bearing case. Clearing here would re-admit the overlapping
      // passes this gate exists to remove, under exactly the saturated-pool
      // conditions that produced the stall — reopening the heap leak at the
      // worst moment. Alert, do not self-heal.
      const onStalled = vi.fn();
      let clock = 0;
      const admitted: number[] = [];
      const gate = createSingleFlightGate({ onStalled, stallAfterMs: 600_000, now: () => clock });

      // 30 s ticks across two hours, the first pass hanging forever.
      for (let tick = 0; tick <= 240; tick += 1) {
        clock = tick * 30_000;
        const started = gate.run(() => {
          admitted.push(clock);
          return deferred().promise;
        });
        if (started) void started.catch(() => undefined);
      }

      // Exactly one pass ever ran. Not one per tick (the pre-gate leak), and not
      // one per threshold either — no amount of stalling admits a second.
      expect(admitted).toEqual([0]);
      expect(gate.busy).toBe(true);
      expect(onStalled).toHaveBeenCalledTimes(1);
    });

    it("stays silent when no threshold is configured", async () => {
      const onStalled = vi.fn();
      let clock = 0;
      const gate = createSingleFlightGate({ onStalled, now: () => clock });
      gate.run(() => deferred().promise);

      clock = 30 * 24 * 60 * 60_000;
      expect(gate.run(async () => undefined)).toBeNull();
      expect(onStalled).not.toHaveBeenCalled();
      expect(gate.busy).toBe(true);
    });

    it("does not report a pass that settles inside the threshold", async () => {
      const onStalled = vi.fn();
      const onSettled = vi.fn();
      let clock = 0;
      const gate = createSingleFlightGate({
        onStalled,
        onSettled,
        stallAfterMs: 600_000,
        now: () => clock,
      });

      const slow = deferred();
      const tracked = gate.run(() => slow.promise);
      clock = 400_000;
      slow.resolve();
      await tracked;

      expect(onStalled).not.toHaveBeenCalled();
      expect(onSettled).toHaveBeenCalledWith(400_000);
      expect(gate.busy).toBe(false);
    });

    it("re-arms the report for the next pass once the gate clears", async () => {
      // The latch is per-pass, not per-gate: a worker that recovered from one
      // stall must still be able to report the next.
      const onStalled = vi.fn();
      let clock = 0;
      const gate = createSingleFlightGate({ onStalled, stallAfterMs: 600_000, now: () => clock });

      const first = deferred();
      const tracked = gate.run(() => first.promise);
      clock = 600_000;
      gate.run(async () => undefined);
      expect(onStalled).toHaveBeenCalledTimes(1);

      first.resolve();
      await tracked;

      gate.run(() => deferred().promise);
      clock = 1_200_001;
      gate.run(async () => undefined);
      expect(onStalled).toHaveBeenCalledTimes(2);
    });
  });
});
