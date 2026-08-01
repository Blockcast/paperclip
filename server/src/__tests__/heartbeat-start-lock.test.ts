import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetAgentStartLocksForTesting,
  _settleDetachedAgentStartLockWorkForTesting,
  withAgentStartLock,
} from "../services/agent-start-lock.js";

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

  it("does not deadlock when two agents' dispatch passes nest into each other", async () => {
    // The orphan reaper is not agent-scoped, so reap -> promote -> dispatch can
    // cross from agent A's critical section into agent B's while a concurrent
    // pass crosses from B into A. Before the deadlock guard both nested calls
    // awaited the other agent's follow-up — and that follow-up could only start
    // once the very section that was waiting had finished. A cycle, with no
    // timeout left to break it.
    const agentA = randomUUID();
    const agentB = randomUUID();
    const bothEntered = deferred<void>();
    let entered = 0;

    const nestedIntoA = vi.fn(async () => "nested-a");
    const nestedIntoB = vi.fn(async () => "nested-b");
    const nestedResults: string[] = [];

    const outerSection = (otherAgentId: string, nested: () => Promise<string>) => async () => {
      entered += 1;
      if (entered === 2) bothEntered.resolve();
      // Park until both sections are held concurrently, so each nested call is
      // guaranteed to find the other agent's lock busy.
      await bothEntered.promise;
      nestedResults.push(await withAgentStartLock(otherAgentId, nested, coalesced));
      return "outer";
    };

    const passA = withAgentStartLock(agentA, outerSection(agentB, nestedIntoB), coalesced);
    const passB = withAgentStartLock(agentB, outerSection(agentA, nestedIntoA), coalesced);

    let deadlockTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlocked = new Promise<never>((_resolve, reject) => {
      deadlockTimer = setTimeout(() => reject(new Error("cross-agent dispatch deadlocked")), 5_000);
    });
    try {
      await expect(Promise.race([Promise.all([passA, passB]), deadlocked])).resolves.toEqual([
        "outer",
        "outer",
      ]);
    } finally {
      clearTimeout(deadlockTimer);
    }

    // Neither nested call blocked on the other agent's lock.
    expect(nestedResults).toEqual(["coalesced", "coalesced"]);

    // The nested work is deferred, not dropped: each was registered as a
    // coalesced follow-up and runs once the holding section releases.
    await _settleDetachedAgentStartLockWorkForTesting();
    expect(nestedIntoA).toHaveBeenCalledTimes(1);
    expect(nestedIntoB).toHaveBeenCalledTimes(1);
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

  it("notifies callers when demand folds into a running follow-up", async () => {
    const agentId = randomUUID();
    const first = deferred<string>();
    const onCoalescedDemand = vi.fn();
    const later = vi.fn(async () => "later");

    const held = withAgentStartLock(
      agentId,
      async () => first.promise,
      coalesced,
    );
    await Promise.resolve();

    const joined = withAgentStartLock(agentId, later, {
      onCoalesced: () => "coalesced" as const,
      onCoalescedDemand,
    });

    expect(onCoalescedDemand).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();

    first.resolve("first");
    await expect(held).resolves.toBe("first");
    await expect(joined).resolves.toBe("later");
    expect(later).toHaveBeenCalledTimes(1);
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

  it("caps nesting depth by detaching the deepest call instead of dropping it", async () => {
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

    // The chain is CUT at the depth bound rather than recursed through: the
    // 5th call returns `onCoalesced()` to its caller instead of the nested
    // result, so the top-level call never sees "leaf".
    await expect(nest(0)).resolves.toBe("depth-capped");

    // ...but the demand must not be discarded. Previously the depth guard
    // returned `onCoalesced()` without registering anything, so when the 5th
    // agent's own lock was free there was no pass to fold into and its queue
    // stalled until an unrelated wake. It now runs detached at top level, and
    // because that resets the depth the rest of the chain proceeds from there.
    await _settleDetachedAgentStartLockWorkForTesting();
    expect(calls).toEqual(ids);
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
