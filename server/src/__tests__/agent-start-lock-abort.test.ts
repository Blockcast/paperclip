import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetAgentStartLocksForTesting,
  AgentStartLockAbortedError,
  currentAgentStartLockSignal,
  describeAgentStartLockDispatchHealth,
  describeHeldAgentStartLocks,
  withAgentStartLock,
} from "../services/agent-start-lock.js";
import { logger } from "../middleware/logger.js";

/**
 * PEN-3328. PEN-3305 made a wedged dispatch section *visible*; it did not bound
 * it. The lock was released if and only if `fn` settled, so any indefinite
 * await inside the critical section was a permanent, silent, per-agent dispatch
 * outage clearable only by replacing the process — measured 2026-09-15/16 as
 * five agents dark for 6–19 h each.
 *
 * The fix is cancellation, not a timeout bypass, and the distinction is the
 * whole design. A timer that stops waiting for `fn` and starts the next section
 * is the BLO-20396 defect: two dispatchers scanning and mutating one queue.
 * Instead the section gets an `AbortSignal`, its awaits observe it, `fn`
 * *rejects*, and the lock is released by the `finally` that was already there.
 * `runExclusively` never stops awaiting `execution`, so the next section cannot
 * begin until the previous one has genuinely settled.
 *
 * Two of these tests carry an explicit negative control — a section that
 * ignores the signal, i.e. the same scenario with the cancellation removed —
 * and assert the opposite outcome. Without them a green suite here would be
 * indistinguishable from one that passes because five simulated minutes elapsed.
 */

const coalesced = { onCoalesced: () => "coalesced" as const };

/** The log-escalation threshold in `agent-start-lock.ts` — attention, not abort. */
const LOCK_HELD_ERROR_MS = 5 * 60_000;

/** The abort threshold in `agent-start-lock.ts`. */
const LOCK_ABORT_MS = 4 * 60 * 60_000;

/** The `warnTimer` tick interval in `agent-start-lock.ts`. */
const LOCK_HELD_WARN_MS = 30_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A section await that never settles on its own and *does* observe the abort
 * signal — the post-fix behaviour of the dispatch path's database awaits, where
 * postgres.js `Query#cancel()` rejects the statement.
 */
function abortableAwait(): Promise<never> {
  const signal = currentAgentStartLockSignal();
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/**
 * The same await with cancellation removed: it ignores the signal entirely.
 * This is the pre-fix behaviour and the negative control.
 */
function unabortableAwait(): Promise<never> {
  return new Promise<never>(() => {});
}

describe("agent start lock cancellation (PEN-3328)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetAgentStartLocksForTesting();
  });

  it("rejects a wedged section at the budget and releases the lock through the existing finally", async () => {
    vi.useFakeTimers();
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    const agentId = randomUUID();

    const held = withAgentStartLock(agentId, abortableAwait, coalesced);
    const settled = held.then(
      () => "resolved" as const,
      (err: unknown) => err,
    );

    await vi.advanceTimersByTimeAsync(LOCK_ABORT_MS - 1_000);
    // Still held: the abort must not fire early, or a slow-but-progressing
    // section gets killed and its half-claimed runs have to be reaped.
    expect(describeHeldAgentStartLocks()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_000);

    const outcome = await settled;
    expect(outcome).toBeInstanceOf(AgentStartLockAbortedError);
    expect((outcome as AgentStartLockAbortedError).agentId).toBe(agentId);
    // Released by the `finally` in `runExclusively` — not by a separate path.
    expect(describeHeldAgentStartLocks()).toEqual([]);
  });

  it(
    "lets a section that passes the log-escalation threshold settle, instead of cancelling it",
    async () => {
      vi.useFakeTimers();
      vi.spyOn(logger, "warn").mockImplementation(() => logger);
      const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
      const agentId = randomUUID();

      // A section that observes the signal and would reject instantly if
      // aborted, but otherwise settles on its own — the "slow but settling"
      // class that production measurement showed is the common case, not the
      // exception. Over the gauge's first four days 21 of 23 agents held the
      // lock past LOCK_HELD_ERROR_MS, peaking at 8073s, and those holds ended
      // with no pod recreation and no container restart.
      const work = deferred<string>();
      const held = withAgentStartLock(
        agentId,
        async () => {
          const signal = currentAgentStartLockSignal();
          return await Promise.race([
            work.promise,
            new Promise<never>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
          ]);
        },
        coalesced,
      );

      // Well past the attention threshold — the operator-facing `error` line is
      // expected here — but far short of the abort budget.
      await vi.advanceTimersByTimeAsync(LOCK_HELD_ERROR_MS * 6);
      expect(error).toHaveBeenCalled();
      // The critical assertion: the section is still running. Cancelling here
      // would not merely waste a pass — the dispatch demand is re-queued, so
      // the retry would reach the same boundary and be cancelled again,
      // turning a slow success into a permanent failure.
      expect(describeHeldAgentStartLocks()).toHaveLength(1);
      // `null` means no abort was ever recorded for this agent.
      expect(describeAgentStartLockDispatchHealth(agentId)).toBeNull();

      work.resolve("dispatched");
      await expect(held).resolves.toBe("dispatched");
      expect(describeHeldAgentStartLocks()).toEqual([]);
    },
  );

  it(
    "NEGATIVE CONTROL: a section that ignores the signal is not released, and no follow-up runs",
    async () => {
      vi.useFakeTimers();
      vi.spyOn(logger, "warn").mockImplementation(() => logger);
      vi.spyOn(logger, "error").mockImplementation(() => logger);
      const agentId = randomUUID();

      let rejected = false;
      const held = withAgentStartLock(agentId, unabortableAwait, coalesced);
      void held.catch(() => {
        rejected = true;
      });
      await vi.advanceTimersByTimeAsync(0);

      // A contender arrives and is folded into the coalesced follow-up. It must
      // stay folded: the holder is still running, signal or no signal.
      let followUpEntered = false;
      const follower = withAgentStartLock(
        agentId,
        async () => {
          followUpEntered = true;
          return "follow-up";
        },
        coalesced,
      );
      void follower.catch(() => {});

      await vi.advanceTimersByTimeAsync(4 * LOCK_ABORT_MS);

      // These are the assertions that make the suite discriminate. If the
      // implementation ever "fixes" liveness by abandoning `fn` on a timer, the
      // holder is released here and the follow-up runs alongside it — so this
      // test goes red, which is the intended alarm: that is the BLO-20396
      // defect (two dispatchers scanning and mutating one queue), not a fix.
      expect(rejected).toBe(false);
      expect(followUpEntered).toBe(false);
      expect(describeHeldAgentStartLocks()).toHaveLength(1);

      // And the agent still reports the fault rather than presenting as idle.
      expect(describeAgentStartLockDispatchHealth(agentId)).toMatchObject({ status: "stalled" });

      // Still reporting well past the abort-record retention window (1 h).
      // Retention is for *released* records, which are post-mortems; this
      // section never released, so the wedge is live and must stay visible.
      // The measured PEN-3305 outages ran 6–19 h, so expiring on age alone
      // would leave the agent reading `status: idle` for most of every outage
      // this surface exists to describe. Two hours is past the window and
      // still inside the range of a real one.
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(describeHeldAgentStartLocks()).toHaveLength(1);
      expect(describeAgentStartLockDispatchHealth(agentId)).toMatchObject({ status: "stalled" });
    },
  );

  it("never runs two sections concurrently for the same agent, including across a cancellation", async () => {    vi.useFakeTimers();
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    const agentId = randomUUID();

    const events: string[] = [];
    let inSection = 0;
    let peakConcurrent = 0;
    const secondFinished = deferred<void>();

    const section = (name: string, body: () => Promise<unknown>) => async () => {
      inSection += 1;
      peakConcurrent = Math.max(peakConcurrent, inSection);
      events.push(`${name}:enter`);
      try {
        return await body();
      } finally {
        inSection -= 1;
        events.push(`${name}:exit`);
      }
    };

    // First section wedges on an abortable await.
    const first = withAgentStartLock(agentId, section("first", abortableAwait), coalesced);
    void first.catch(() => events.push("first:rejected"));
    await vi.advanceTimersByTimeAsync(0);

    // A second caller arrives while the lock is held. It must be folded into the
    // single coalesced follow-up and must NOT begin until the first has settled.
    const second = withAgentStartLock(
      agentId,
      section("second", async () => {
        secondFinished.resolve();
        return "second-done";
      }),
      coalesced,
    );

    // Five minutes of contention with the holder wedged. Before PEN-3328 this
    // window was unbounded; the point of the assertion is that it is bounded
    // WITHOUT the follow-up ever overlapping the holder.
    await vi.advanceTimersByTimeAsync(LOCK_ABORT_MS + 1_000);
    await secondFinished.promise;

    expect(await second).toBe("second-done");
    await expect(first).rejects.toBeInstanceOf(AgentStartLockAbortedError);

    // The load-bearing assertion: the follow-up entered only after the wedged
    // section exited. A timeout bypass would interleave these.
    expect(events.indexOf("second:enter")).toBeGreaterThan(events.indexOf("first:exit"));
    expect(peakConcurrent).toBe(1);
    expect(events.filter((e) => e.endsWith(":enter"))).toEqual(["first:enter", "second:enter"]);
  });

  it("surfaces why dispatch aborted instead of leaving the agent reading idle", async () => {
    vi.useFakeTimers();
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    const agentId = randomUUID();

    // Nothing to report before anything goes wrong — the common case.
    expect(describeAgentStartLockDispatchHealth(agentId)).toBeNull();

    const held = withAgentStartLock(agentId, abortableAwait, coalesced);
    void held.catch(() => {});
    await vi.advanceTimersByTimeAsync(LOCK_ABORT_MS + 1_000);
    await expect(held).rejects.toBeInstanceOf(AgentStartLockAbortedError);

    const health = describeAgentStartLockDispatchHealth(agentId);
    // `aborted`, not `stalled`: the lock was released and dispatch has resumed,
    // so this is a post-mortem rather than a live outage. Collapsing the two
    // would tell an operator to replace a pod that is already healthy.
    expect(health).toMatchObject({ status: "aborted" });
    expect(health?.reason).toMatch(/cancelled/i);
    expect(health?.reason).toMatch(/queued runs were not lost/i);
    expect(Date.parse(health!.abortedAt)).toBeGreaterThan(0);
    expect(health?.heldMs).toBeGreaterThanOrEqual(LOCK_ABORT_MS);

    // The other half of the retention rule. This record *did* release, so it is
    // genuinely history and stops being reported once the window passes —
    // otherwise a one-off abort would follow the agent around forever. Paired
    // with the negative control's unreleased record, which must NOT expire,
    // this is what pins retention to `released` rather than to age.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(describeAgentStartLockDispatchHealth(agentId)).toBeNull();
  });

  it("counts the abort on a metric, because the gauge series vanishes with the lock", async () => {
    vi.useFakeTimers();
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    const agentId = randomUUID();
    const { renderMetrics } = await import("../services/metrics.js");

    const held = withAgentStartLock(agentId, abortableAwait, coalesced);
    void held.catch(() => {});
    await vi.advanceTimersByTimeAsync(LOCK_ABORT_MS + 1_000);
    await expect(held).rejects.toBeInstanceOf(AgentStartLockAbortedError);

    // `paperclip_agent_start_lock_held_seconds` is gone by now — the lock was
    // released, which is the fix working. Without this counter the event would
    // leave no durable trace anywhere Prometheus can reach.
    expect(describeHeldAgentStartLocks()).toEqual([]);
    const { body } = await renderMetrics();
    expect(body).toContain(`paperclip_agent_start_lock_aborted_total{agent_id="${agentId}"} 1`);
  });

  it("leaves a healthy section untouched and reports nothing for it", async () => {
    vi.useFakeTimers();
    const agentId = randomUUID();

    const result = await withAgentStartLock(agentId, async () => "ok", coalesced);

    expect(result).toBe("ok");
    expect(describeHeldAgentStartLocks()).toEqual([]);
    expect(describeAgentStartLockDispatchHealth(agentId)).toBeNull();
  });

  it("does not leak the section signal into work launched from inside it", async () => {
    vi.useFakeTimers();
    const agentId = randomUUID();
    const { runDetachedFromAgentStartLock } = await import("../services/agent-start-lock.js");

    let detachedSignal: AbortSignal | undefined = new AbortController().signal;
    await withAgentStartLock(
      agentId,
      async () => {
        expect(currentAgentStartLockSignal()).toBeDefined();
        // `executeRun` is launched this way and outlives the section. If it
        // inherited the signal, aborting a later wedge would cancel the run's
        // own database work — tearing down live work that has nothing to do
        // with queue selection.
        runDetachedFromAgentStartLock(() => {
          detachedSignal = currentAgentStartLockSignal();
        });
        return "ok";
      },
      coalesced,
    );

    expect(detachedSignal).toBeUndefined();
  });
});
