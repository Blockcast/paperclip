/**
 * BLO-20410 — a transient 60s `initialize` timeout at pod start used to latch a
 * plugin at status='error' forever. Four of eleven plugins (including
 * `lucitra.plugin-secrets`) sat dead for 9+ hours and every one of them
 * recovered from a single manual `/enable` with no other change.
 *
 * Two guarantees are covered here:
 *   1. the timeout is classified transient (retried) while a real plugin fault
 *      is still classified terminal (fails closed on the first attempt);
 *   2. boot activation is bounded, so the plugin set no longer contends for one
 *      60s initialize window.
 */
import { describe, expect, it } from "vitest";
import {
  TRANSIENT_ACTIVATION_RETRY_DELAYS_MS,
  isTransientActivationError,
  mapWithConcurrency,
  resolveActivationConcurrency,
} from "../services/plugin-loader.js";

describe("isTransientActivationError", () => {
  it("classifies the observed production initialize timeout as transient", () => {
    // Verbatim from the four errored plugins' lastError (BLO-20410).
    const observed = new Error(
      'Worker initialize failed for "lucitra.plugin-secrets": ' +
        'RPC call "initialize" timed out after 60000ms',
    );
    expect(isTransientActivationError(observed)).toBe(true);
  });

  it("classifies a worker that dies during startup as transient", () => {
    expect(
      isTransientActivationError(new Error("Worker exited during startup (code 1)")),
    ).toBe(true);
  });

  it("does NOT retry a plugin that reports a real fault inside the budget", () => {
    // ok=false is the plugin answering "I am broken" — retrying just delays a
    // legitimate error latch.
    expect(
      isTransientActivationError(new Error("Worker initialize returned ok=false")),
    ).toBe(false);
  });

  it("does NOT retry structural faults", () => {
    for (const message of [
      "Worker entrypoint not found: dist/worker.js",
      "Invalid plugin manifest: missing 'id'",
      "ERR_MODULE_NOT_FOUND: cannot find package 'left-pad'",
    ]) {
      expect(isTransientActivationError(new Error(message))).toBe(false);
    }
  });

  it("handles non-Error rejections without throwing", () => {
    expect(isTransientActivationError('RPC call "initialize" timed out after 60000ms')).toBe(
      true,
    );
    expect(isTransientActivationError(undefined)).toBe(false);
  });

  it("budgets more than one retry but keeps the added boot delay small", () => {
    // Each attempt can burn the full 60s initialize budget, so the schedule has
    // to stay short or a bad boot serializes into minutes.
    expect(TRANSIENT_ACTIVATION_RETRY_DELAYS_MS.length).toBeGreaterThanOrEqual(1);
    const total = TRANSIENT_ACTIVATION_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(30_000);
  });
});

describe("resolveActivationConcurrency", () => {
  const KEY = "PAPERCLIP_PLUGIN_ACTIVATION_CONCURRENCY";
  const withEnv = (value: string | undefined, run: () => void) => {
    const prior = process.env[KEY];
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    try {
      run();
    } finally {
      if (prior === undefined) delete process.env[KEY];
      else process.env[KEY] = prior;
    }
  };

  it("defaults to a bounded value rather than unbounded fan-out", () => {
    withEnv(undefined, () => {
      const value = resolveActivationConcurrency();
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(8);
    });
  });

  it("honours a valid override", () => {
    withEnv("2", () => expect(resolveActivationConcurrency()).toBe(2));
  });

  it("falls back to the default on garbage or non-positive input", () => {
    withEnv("not-a-number", () => expect(resolveActivationConcurrency()).toBe(4));
    withEnv("0", () => expect(resolveActivationConcurrency()).toBe(4));
    withEnv("-3", () => expect(resolveActivationConcurrency()).toBe(4));
  });
});

describe("mapWithConcurrency", () => {
  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 11 }, (_, i) => i);

    await mapWithConcurrency(items, 4, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return item;
    });

    // The regression: 11 plugins all entering the 60s initialize window at once.
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("preserves input order in the results", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const results = await mapWithConcurrency(items, 2, async (item, index) => {
      // Invert the delay so completion order differs from input order.
      await new Promise((r) => setTimeout(r, (items.length - index) * 4));
      return item.toUpperCase();
    });

    expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);
  });

  it("isolates failures so one bad plugin cannot abort the rest", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error("activation exploded");
      return item * 10;
    });

    expect(results[0]).toEqual({ status: "fulfilled", value: 10 });
    expect(results[1]?.status).toBe("rejected");
    expect(results[2]).toEqual({ status: "fulfilled", value: 30 });
  });

  it("runs every item even when the list is longer than the limit", async () => {
    const seen: number[] = [];
    const items = Array.from({ length: 25 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (item) => {
      seen.push(item);
      return item;
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it("handles an empty list without hanging", async () => {
    await expect(mapWithConcurrency([], 4, async (x) => x)).resolves.toEqual([]);
  });
});
