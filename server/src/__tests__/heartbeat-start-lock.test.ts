import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetAgentStartLocksForTesting, withAgentStartLock } from "../services/agent-start-lock.js";

const coalesced = { onCoalesced: () => "coalesced" as const };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("heartbeat agent start lock (BLO-20396)", () => {
  afterEach(() => {
    vi.useRealTimers();
    _resetAgentStartLocksForTesting();
  });

  it("never runs two critical sections for one agent concurrently, even past the old 30s budget", async () => {
    vi.useFakeTimers();

    const agentId = randomUUID();
    const first = deferred<string>();
    let concurrent = 0;
    let maxConcurrent = 0;

    const section = (result: string, gate?: Promise<string>) =>
      vi.fn(async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        try {
          if (gate) await gate;
          return result;
        } finally {
          concurrent -= 1;
        }
      });

    const firstStart = section("first", first.promise);
    const held = withAgentStartLock(agentId, firstStart, coalesced);
    await Promise.resolve();
    expect(firstStart).toHaveBeenCalledTimes(1);

    // Many concurrent wakes arrive while the first section is still running.
    const laterStarts = Array.from({ length: 12 }, () => section("later"));
    const laterResults = laterStarts.map((fn) => withAgentStartLock(agentId, fn, coalesced));

    // Blow well past the old AGENT_START_LOCK_STALE_MS budget. The old
    // implementation bypassed the lock here and ran every waiter concurrently.
    await vi.advanceTimersByTimeAsync(120_000);
    for (const fn of laterStarts) expect(fn).not.toHaveBeenCalled();
    expect(maxConcurrent).toBe(1);

    first.resolve("first");
    await expect(held).resolves.toBe("first");
    await expect(Promise.all(laterResults)).resolves.toEqual(Array(12).fill("later"));

    // All 12 contenders coalesced into exactly one follow-up pass.
    const ran = laterStarts.filter((fn) => fn.mock.calls.length > 0);
    expect(ran).toHaveLength(1);
    expect(maxConcurrent).toBe(1);
  });

  it("releases the lock when a critical section rejects", async () => {
    const agentId = randomUUID();
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    const next = vi.fn(async () => "next");

    await expect(withAgentStartLock(agentId, failing, coalesced)).rejects.toThrow("boom");
    await expect(withAgentStartLock(agentId, next, coalesced)).resolves.toBe("next");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("surfaces a synchronous throw as a rejection without wedging the lock", async () => {
    const agentId = randomUUID();
    const throwsSync = vi.fn((() => {
      throw new Error("sync boom");
    }) as unknown as () => Promise<string>);
    const next = vi.fn(async () => "next");

    await expect(withAgentStartLock(agentId, throwsSync, coalesced)).rejects.toThrow("sync boom");
    await expect(withAgentStartLock(agentId, next, coalesced)).resolves.toBe("next");
  });

  it("coalesces a re-entrant call for the same agent instead of deadlocking", async () => {
    const agentId = randomUUID();
    const inner = vi.fn(async () => "inner");

    // Mirrors reap → releaseIssueExecutionAndPromote → startNextQueuedRunForAgent
    // re-entering dispatch for the agent whose lock is already held.
    const result = await withAgentStartLock(
      agentId,
      async () => withAgentStartLock(agentId, inner, coalesced),
      coalesced,
    );

    expect(result).toBe("coalesced");
    expect(inner).not.toHaveBeenCalled();
  });

  it("allows nesting across different agents but caps the depth", async () => {
    const ids = Array.from({ length: 6 }, () => randomUUID());
    const calls: string[] = [];

    const nest = async (depth: number): Promise<string> => {
      if (depth >= ids.length) return "leaf";
      return withAgentStartLock(
        ids[depth],
        async () => {
          calls.push(ids[depth]);
          return nest(depth + 1);
        },
        { onCoalesced: () => "depth-capped" as const },
      );
    };

    await expect(nest(0)).resolves.toBe("depth-capped");
    // MAX_NESTED_DISPATCH_DEPTH is 4, so the 5th distinct agent is refused.
    expect(calls).toHaveLength(4);
  });

  it("serializes a burst so each queued item is handed out at most once", async () => {
    const agentId = randomUUID();
    const queue = Array.from({ length: 20 }, (_, i) => i);
    const claimed: number[] = [];

    const drainOne = async () => {
      const next = queue.shift();
      if (next === undefined) return null;
      // Yield mid-section: with a real mutex this interleaving is safe; under
      // the old bypass two passes could shift the same logical slot.
      await Promise.resolve();
      claimed.push(next);
      return next;
    };

    await Promise.all(
      Array.from({ length: 20 }, () =>
        withAgentStartLock(agentId, drainOne, { onCoalesced: () => null })),
    );

    expect(new Set(claimed).size).toBe(claimed.length);
  });
});
