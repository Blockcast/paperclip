// Tests for the single-flight latch that stops the periodic heartbeat
// recovery chain from running concurrently with itself (BLO-30203).
//
// The failure this guards against is not an incorrect result — every stage of
// the chain is an idempotent sweep — it is retention. `setInterval` fires every
// 30 s and the chain routinely takes longer, so without the latch N copies are
// alive at once and each holds its own full hydrated snapshot of the issue
// graph. That is what drove the worker into its 6 GiB heap ceiling.

import { describe, it, expect } from "vitest";
import { createSingleFlight } from "../services/single-flight.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSingleFlight", () => {
  it("declines a second start while the first is still settling", async () => {
    const runOnce = createSingleFlight();
    const gate = deferred<string>();
    let starts = 0;

    const first = runOnce(() => {
      starts += 1;
      return gate.promise;
    });
    const second = runOnce(() => {
      starts += 1;
      return Promise.resolve("second");
    });

    // The declined call must not invoke the task at all — invoking it and
    // discarding the promise would still do the DB work and still retain the
    // snapshot, which is the entire cost this latch exists to avoid.
    expect(starts).toBe(1);
    expect(first).not.toBeNull();
    expect(second).toBeNull();

    gate.resolve("first");
    await expect(first).resolves.toBe("first");
  });

  it("re-opens once the in-flight pass settles", async () => {
    const runOnce = createSingleFlight();
    const gate = deferred<string>();

    const first = runOnce(() => gate.promise);
    expect(runOnce(() => Promise.resolve("blocked"))).toBeNull();

    gate.resolve("first");
    await first;

    const third = runOnce(() => Promise.resolve("third"));
    expect(third).not.toBeNull();
    await expect(third).resolves.toBe("third");
  });

  it("re-opens when the pass rejects, so one failure cannot wedge the sweep", async () => {
    const runOnce = createSingleFlight();
    const gate = deferred<string>();

    const first = runOnce(() => gate.promise);
    gate.reject(new Error("pass failed"));
    await expect(first).rejects.toThrow("pass failed");

    const next = runOnce(() => Promise.resolve("recovered"));
    expect(next).not.toBeNull();
    await expect(next).resolves.toBe("recovered");
  });

  it("re-opens when the task throws synchronously", async () => {
    const runOnce = createSingleFlight();

    expect(() =>
      runOnce(() => {
        throw new Error("sync boom");
      }),
    ).toThrow("sync boom");

    const next = runOnce(() => Promise.resolve("recovered"));
    expect(next).not.toBeNull();
    await expect(next).resolves.toBe("recovered");
  });

  it("keeps separate latches independent", async () => {
    const runA = createSingleFlight();
    const runB = createSingleFlight();
    const gate = deferred<string>();

    const a = runA(() => gate.promise);
    expect(runA(() => Promise.resolve("a2"))).toBeNull();
    // A different sweep must not be blocked by A's in-flight pass.
    expect(runB(() => Promise.resolve("b1"))).not.toBeNull();

    gate.resolve("a1");
    await a;
  });
});
