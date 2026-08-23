import { describe, expect, it } from "vitest";
import {
  pendingLockKeyCount,
  withStateLock,
} from "../state-lock.js";

// `withStateLock` is the load-bearing primitive behind every BLO-23143 fix, but
// it was covered only indirectly through the worker's jobs and listeners. These
// exercise its three contracts directly, so a refactor that quietly serialized
// every company behind one chain — or wedged a key after one rejection — fails
// here instead of surfacing as lost watch events in production (BLO-28764).

/** Yield to the macrotask queue. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("withStateLock", () => {
  it("serializes callers for the same key", async () => {
    const order: string[] = [];
    const body = (id: string) => async () => {
      order.push(`${id}:start`);
      await tick();
      order.push(`${id}:end`);
    };

    await Promise.all([
      withStateLock("same-key", body("first")),
      withStateLock("same-key", body("second")),
    ]);

    // Interleaved would be first:start, second:start, first:end, second:end.
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("does not wedge the key when a holder rejects", async () => {
    const boom = withStateLock("rejecting-key", async () => {
      await tick();
      throw new Error("holder failed");
    });
    // The rejection belongs to the caller, not to the key.
    await expect(boom).rejects.toThrow("holder failed");

    // A waiter queued behind the failure still runs, and observes the store as
    // the failed holder left it rather than never being scheduled at all.
    await expect(
      withStateLock("rejecting-key", async () => {
        await tick();
        return "ran anyway";
      }),
    ).resolves.toBe("ran anyway");
  });

  it("queues a waiter behind a rejecting holder rather than running it early", async () => {
    const order: string[] = [];
    const failing = withStateLock("ordered-key", async () => {
      order.push("failing:start");
      await tick();
      order.push("failing:end");
      throw new Error("holder failed");
    });
    const waiter = withStateLock("ordered-key", async () => {
      order.push("waiter:start");
    });

    await expect(failing).rejects.toThrow("holder failed");
    await waiter;
    expect(order).toEqual(["failing:start", "failing:end", "waiter:start"]);
  });

  it("runs different keys concurrently", async () => {
    const order: string[] = [];
    const body = (id: string) => async () => {
      order.push(`${id}:start`);
      await tick();
      order.push(`${id}:end`);
    };

    await Promise.all([
      withStateLock("key-a", body("a")),
      withStateLock("key-b", body("b")),
    ]);

    // Distinct keys must genuinely overlap. If a refactor collapsed them onto
    // one chain this would read a:start, a:end, b:start, b:end — every company
    // serialized behind every other, which is the throughput regression the
    // per-key design exists to avoid.
    expect(order).toEqual(["a:start", "b:start", "a:end", "b:end"]);
  });

  it("drops the map entry once a key's tail settles", async () => {
    const before = pendingLockKeyCount();

    await Promise.all([
      withStateLock("bounded-a", async () => {
        await tick();
      }),
      withStateLock("bounded-b", async () => {
        await tick();
      }),
      withStateLock("bounded-b", async () => {
        throw new Error("rejects, but must still be cleaned up");
      }).catch(() => undefined),
    ]);
    // Cleanup is a `.then` on the settled tail, so it lands a microtask later.
    await tick();

    // A worker holds one key per company per day; leaking them is unbounded
    // growth with no symptom until memory pressure.
    expect(pendingLockKeyCount()).toBe(before);
  });
});
