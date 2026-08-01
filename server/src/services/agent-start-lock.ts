import { AsyncLocalStorage } from "node:async_hooks";

import { logger } from "../middleware/logger.js";

/**
 * Per-agent serialization for queued-run dispatch (BLO-20396).
 *
 * The previous implementation chained each caller onto the previous caller's
 * promise and, after a 30s budget, simply *stopped waiting* and ran anyway.
 * That turned the lock into a concurrency amplifier under backlog: overlapping
 * dispatchers scanned and mutated the same queue, re-cancelled the same rows,
 * and logged the same cancellation repeatedly. Worse, the budget was measured
 * from when a waiter was *registered*, so a caller's own queue wait was charged
 * against its execution budget.
 *
 * This module replaces that with a coalescing single-flight dispatcher:
 *
 *   - Free agent            → run immediately, holding the lock.
 *   - Busy agent            → join a single coalesced follow-up that starts once
 *                             the in-flight section finishes. Every caller that
 *                             arrives while the lock is held shares that one
 *                             follow-up, so N concurrent wakes produce at most
 *                             one extra pass instead of N queued passes.
 *   - Re-entrant / too deep → do not run; return `onCoalesced()`.
 *
 * There is no timeout bypass. A timeout must never downgrade mutual exclusion —
 * that was the defect. Liveness comes instead from (a) removing the re-entrancy
 * that used to self-deadlock and (b) bounding the critical section's work. A
 * section that overruns `LOCK_HELD_WARN_MS` is logged loudly rather than
 * silently overtaken.
 *
 * Re-entrancy matters here and is not hypothetical. `startNextQueuedRunForAgent`
 * calls `reapOrphanedRuns`, which is not agent-scoped and can reach
 * `releaseIssueExecutionAndPromote` → `startNextQueuedRunForAgent` for another
 * agent (or, via a cycle, the same one). Under a strict mutex that same-agent
 * path would deadlock; the old 30s bypass was the only thing defusing it. We
 * detect it directly with an AsyncLocalStorage-tracked set of agent ids held on
 * the current async path, and skip the nested call: the outer section has not
 * yet selected its queue, so it will pick up the same work anyway.
 *
 * Callers must pass the same `fn` semantics for a given agentId — a coalesced
 * follow-up executes the *first* contender's callback and shares its result
 * with everyone who joined. `startNextQueuedRunForAgent` is the only caller and
 * satisfies this (it closes over nothing but `agentId`). A joined caller
 * therefore observes the runs that the shared pass claimed; the claim itself
 * still happens exactly once.
 */

/** Warn (do not bypass) when one critical section runs longer than this. */
const LOCK_HELD_WARN_MS = 30_000;

/**
 * Maximum number of distinct agents whose locks may be held on a single async
 * path. Bounds reap → promote → dispatch amplification; beyond this depth a
 * nested dispatch is skipped rather than recursing further.
 */
const MAX_NESTED_DISPATCH_DEPTH = 4;

/** The critical section currently executing for an agent, if any. */
const runningByAgent = new Map<string, Promise<void>>();

/** The single coalesced follow-up queued behind the running section, if any. */
const followUpByAgent = new Map<string, Promise<unknown>>();

/** Agent ids whose locks are held by the current async execution path. */
const heldAgentIds = new AsyncLocalStorage<ReadonlySet<string>>();

export type AgentStartLockOptions<T> = {
  /**
   * Result to return when this call is folded into another pass instead of
   * running — i.e. it is re-entrant, or nesting is already too deep. Dispatch
   * passes `() => []` (no runs claimed *by this call*).
   */
  onCoalesced: () => T;
};

async function runExclusively<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const held = heldAgentIds.getStore();
  const nextHeld = new Set(held ?? []);
  nextHeld.add(agentId);

  const startedAtMs = Date.now();
  // Wrap so a synchronous throw from `fn` surfaces as a rejection rather than
  // escaping before the lock bookkeeping below is installed.
  const execution = (async () => heldAgentIds.run(nextHeld, fn))();
  // Track a settled-either-way marker so a failing section still releases the
  // lock and still lets the coalesced follow-up run.
  const marker = execution.then(
    () => undefined,
    () => undefined,
  );
  runningByAgent.set(agentId, marker);

  const warnTimer = setTimeout(() => {
    logger.warn(
      { agentId, heldMs: Date.now() - startedAtMs, warnAfterMs: LOCK_HELD_WARN_MS },
      "agent start lock held longer than expected; queued-run dispatch is falling behind",
    );
  }, LOCK_HELD_WARN_MS);
  warnTimer.unref?.();

  try {
    return await execution;
  } finally {
    clearTimeout(warnTimer);
    if (runningByAgent.get(agentId) === marker) runningByAgent.delete(agentId);
  }
}

export async function withAgentStartLock<T>(
  agentId: string,
  fn: () => Promise<T>,
  options: AgentStartLockOptions<T>,
): Promise<T> {
  const held = heldAgentIds.getStore();
  if (held?.has(agentId)) {
    logger.debug(
      { agentId, depth: held.size },
      "agent start lock already held on this path; coalescing nested queued-run dispatch",
    );
    return options.onCoalesced();
  }
  if (held && held.size >= MAX_NESTED_DISPATCH_DEPTH) {
    logger.warn(
      { agentId, depth: held.size, maxDepth: MAX_NESTED_DISPATCH_DEPTH },
      "nested queued-run dispatch exceeded max depth; coalescing to stop cleanup amplification",
    );
    return options.onCoalesced();
  }

  const running = runningByAgent.get(agentId);
  if (!running) return runExclusively(agentId, fn);

  const existingFollowUp = followUpByAgent.get(agentId);
  if (existingFollowUp) return existingFollowUp as Promise<T>;

  // Clear the slot before running so callers arriving *during* the follow-up
  // open a new one rather than joining a pass that has already read the queue.
  // `exit` detaches the follow-up from whichever contender happened to create
  // it, so it runs as a fresh top-level pass rather than inheriting that
  // caller's nesting depth.
  const followUp = running.then(() => {
    followUpByAgent.delete(agentId);
    return heldAgentIds.exit(() => runExclusively(agentId, fn));
  });
  followUpByAgent.set(agentId, followUp);
  return followUp;
}

/**
 * Run `fn` detached from the lock context of the current async path.
 *
 * AsyncLocalStorage propagates into every async continuation, including
 * fire-and-forget work *started* inside a critical section but which outlives
 * it — notably `executeRun`. Without this, a run launched by a dispatch pass
 * would still carry that pass's held-agent set long after the lock released, so
 * the dispatch it triggers on completion would be treated as re-entrant and
 * silently skipped, stalling the queue. Executing a run is not part of queue
 * selection, so it must not inherit the selection lock's context.
 */
export function runDetachedFromAgentStartLock<T>(fn: () => T): T {
  return heldAgentIds.exit(fn);
}

/** Test-only: drop all in-process lock state. */
export function _resetAgentStartLocksForTesting() {
  runningByAgent.clear();
  followUpByAgent.clear();
}
