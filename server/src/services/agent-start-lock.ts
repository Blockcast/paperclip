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
 * There is no timeout bypass *on ordinary contention*. A 30s-scale timeout
 * must never downgrade mutual exclusion — that was the defect. Liveness comes
 * instead from (a) removing the re-entrancy that used to self-deadlock and
 * (b) bounding the critical section's work. A section that overruns
 * `LOCK_HELD_WARN_MS` is logged loudly rather than silently overtaken.
 *
 * BLO-23094: that guarantee assumed `fn` always eventually settles. It does
 * not hold if a future bug puts a genuinely never-resolving await inside
 * `fn` — no amount of re-entrancy guarding or depth capping helps, because
 * the section is not looping or nesting, it is simply stuck. That failure
 * mode wedges the affected agent's dispatch until the process restarts, with
 * no other recovery path, since the lock state is purely in-memory. The
 * module now backstops that one failure mode — and only that one — with
 * `LOCK_FORCE_RELEASE_MS`, an order of magnitude above any duration ordinary
 * contention could plausibly produce. See its comment for why that bound is
 * safe to add without reintroducing the original defect.
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
 * The same reaper makes *cross-agent* cycles reachable too: a pass holding
 * agent A's lock can nest into agent B's, while a concurrent pass holding B
 * nests into A. If both waited, neither would ever finish and nothing would
 * time out. So the module enforces one invariant:
 *
 *   **A caller that holds any agent's lock never awaits another agent's lock.**
 *
 * When such a caller finds the target busy it registers the coalesced follow-up
 * (so the work still happens, detached and at top level) and returns
 * `onCoalesced()` immediately. Only lock-free callers ever block, and a waiter
 * holding nothing cannot be a node in a wait cycle — so no cycle can form.
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
 * Hard liveness ceiling (BLO-23094). If a critical section has not settled
 * after this long, the module concludes it is not "slow" but genuinely
 * *hung* — an await inside `fn` that will never resolve or reject — and
 * force-releases this agent's bookkeeping so new demand is not held hostage
 * forever. Before this, `runningByAgent`/`followUpByAgent` had no liveness
 * backstop at all: a single never-settling `fn()` call wedged that agent's
 * dispatch until the process restarted, no matter how long the incident ran.
 *
 * This is deliberately NOT the BLO-20396 defect reintroduced. That bypass
 * fired at LOCK_HELD_WARN_MS (30s) — well inside the duration of ordinary,
 * even heavily re-entrant/cascaded work (every k8s call in this dispatch
 * path is itself AbortSignal-bounded to a couple of seconds; see
 * k8s-job-liveness.ts) — and let a second section run CONCURRENTLY with the
 * first, which is what produced duplicate scans and repeated cancellations.
 * This ceiling is an order of magnitude higher specifically so that no
 * plausible legitimate section — including one nested MAX_NESTED_DISPATCH_DEPTH
 * deep — can ever reach it; only a genuinely stuck await can.
 *
 * Force-releasing does not cancel the abandoned `fn()` — there is no way to
 * cancel an arbitrary in-flight await from here. It keeps running
 * unobserved, and its eventual settlement is a no-op against the module's
 * bookkeeping (guarded by marker identity, both here and in `runExclusively`'s
 * `finally`), because by then a fresh section may already be running in its
 * place. That sacrifices strict mutual exclusion only in this
 * already-abnormal case — a zombie execution could in principle still be
 * mutating state when a fresh one starts — but the alternative is an agent
 * whose dispatch never recovers without a pod restart, which is strictly
 * worse and is exactly the incident this constant exists to bound.
 */
const LOCK_FORCE_RELEASE_MS = 300_000;

/**
 * Maximum number of distinct agents whose locks may be held on a single async
 * path. Bounds reap → promote → dispatch amplification; beyond this depth a
 * nested dispatch is detached to top level rather than recursing further, so
 * the demand is preserved while the call stack is not.
 */
const MAX_NESTED_DISPATCH_DEPTH = 4;

/** The critical section currently executing for an agent, if any. */
const runningByAgent = new Map<string, Promise<void>>();

/** The single coalesced follow-up queued behind the running section, if any. */
const followUpByAgent = new Map<string, Promise<unknown>>();

/**
 * Follow-up passes that were scheduled without a waiter, because scheduling
 * caller already held another agent's lock (see the deadlock guard below).
 */
const detachedFollowUps = new Set<Promise<unknown>>();

/** Agent ids whose locks are held by the current async execution path. */
const heldAgentIds = new AsyncLocalStorage<ReadonlySet<string>>();

export type AgentStartLockOptions<T> = {
  /**
   * Result to return when this call is folded into another pass instead of
   * running — i.e. it is re-entrant, or nesting is already too deep. Dispatch
   * passes `() => []` (no runs claimed *by this call*).
   */
  onCoalesced: () => T;
  /**
   * Fired when this call arrives while another section already holds the
   * agent's lock and is folded into the single follow-up pass. Callers use this
   * as a liveness signal for demand that arrived after the running section read
   * its queue snapshot.
   */
  onCoalescedDemand?: () => void;
};

async function runExclusively<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const held = heldAgentIds.getStore();
  const nextHeld = new Set(held ?? []);
  nextHeld.add(agentId);

  const startedAtMs = Date.now();
  // Publish the lock BEFORE `fn` is invoked. The wrapper below runs `fn`'s
  // synchronous prefix immediately, so a call that re-enters dispatch within
  // that prefix would find no entry in `runningByAgent` and conclude the lock
  // was free — and the re-entrancy guard's fallback would then start a SECOND
  // critical section for this agent, concurrently with this one. That is the
  // exact property this module exists to guarantee, so the window is closed
  // structurally rather than left to every caller's first statement being an
  // `await`.
  let settleMarker!: () => void;
  const marker = new Promise<void>((resolve) => {
    settleMarker = resolve;
  });
  runningByAgent.set(agentId, marker);

  // Wrap so a synchronous throw from `fn` surfaces as a rejection rather than
  // escaping before the lock bookkeeping below is installed.
  const execution = (async () => heldAgentIds.run(nextHeld, fn))();
  // Settle the marker either way, so a failing section still releases the lock
  // and still lets the coalesced follow-up run.
  void execution.then(settleMarker, settleMarker);

  const warnTimer = setTimeout(() => {
    logger.warn(
      { agentId, heldMs: Date.now() - startedAtMs, warnAfterMs: LOCK_HELD_WARN_MS },
      "agent start lock held longer than expected; queued-run dispatch is falling behind",
    );
  }, LOCK_HELD_WARN_MS);
  warnTimer.unref?.();

  // Liveness backstop (BLO-23094): see LOCK_FORCE_RELEASE_MS for why this
  // ceiling cannot fire on ordinary contention. Guarded by marker identity so
  // it never clobbers a section that already finished and was replaced.
  const forceReleaseTimer = setTimeout(() => {
    if (runningByAgent.get(agentId) !== marker) return;
    logger.error(
      { agentId, heldMs: Date.now() - startedAtMs, forceReleaseAfterMs: LOCK_FORCE_RELEASE_MS },
      "agent start lock force-released after exceeding the hard liveness ceiling; this section is not settling — treat as a bug (unbounded await), not normal contention",
    );
    runningByAgent.delete(agentId);
    // Unblocks any coalesced follow-up chained on `marker` (ensureCoalescedFollowUp
    // awaits it via `running.then(...)`) so queued demand for this agent proceeds
    // on a fresh section instead of waiting on one that may never return.
    settleMarker();
  }, LOCK_FORCE_RELEASE_MS);
  forceReleaseTimer.unref?.();

  try {
    return await execution;
  } finally {
    clearTimeout(warnTimer);
    clearTimeout(forceReleaseTimer);
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
    options.onCoalescedDemand?.();
    // Re-entrant, so this agent's section is by definition already running and
    // `runningByAgent` holds it (published before `fn` is invoked). Chain the
    // follow-up onto it. Never fall back to `runExclusively` here the way the
    // depth guard below does: for the *same* agent that would run a second
    // critical section alongside the one we are nested inside.
    const running = runningByAgent.get(agentId);
    if (running) trackDetachedFollowUp(agentId, ensureCoalescedFollowUp(agentId, fn, running));
    else logger.error({ agentId }, "re-entrant queued-run dispatch found no running section to fold into");
    return options.onCoalesced();
  }
  if (held && held.size >= MAX_NESTED_DISPATCH_DEPTH) {
    logger.warn(
      { agentId, depth: held.size, maxDepth: MAX_NESTED_DISPATCH_DEPTH },
      "nested queued-run dispatch exceeded max depth; detaching to stop cleanup amplification",
    );
    // Bound the recursion without discarding the demand. Returning
    // `onCoalesced()` outright used to drop this agent's dispatch: when its own
    // lock happened to be free there was no pass to fold into, so a
    // reap -> promote chain that reached this depth left the agent's newly
    // runnable queue stalled until an unrelated wake.
    //
    // Detaching satisfies both invariants at once. Nothing recurses — the pass
    // is re-entered at top level, so depth does not grow — and the work still
    // happens. This is the same shape the deadlock guard below already uses for
    // the busy-lock case; only the free-lock case was leaking demand.
    const running = runningByAgent.get(agentId);
    const followUp = running
      ? ensureCoalescedFollowUp(agentId, fn, running)
      : heldAgentIds.exit(() => runExclusively(agentId, fn));
    trackDetachedFollowUp(agentId, followUp);
    return options.onCoalesced();
  }

  const running = runningByAgent.get(agentId);
  if (!running) return runExclusively(agentId, fn);

  options.onCoalescedDemand?.();
  const followUp = ensureCoalescedFollowUp(agentId, fn, running);

  // Deadlock guard: a caller that already holds *another* agent's lock must
  // never wait on this one. Two dispatch passes that each hold one agent's
  // lock and then await the other's wait on each other forever, and there is
  // no longer a timeout to break the cycle. That shape is reachable, not
  // hypothetical: the orphan reaper is not agent-scoped, so
  // reap -> promote -> dispatch crosses from agent A's section into agent B's
  // and can come back to A.
  //
  // The follow-up registered above already runs detached at top level, so the
  // work still happens on schedule; this caller simply does not block on it.
  // That yields the invariant which makes a cycle impossible: a caller holding
  // any lock never awaits another, so only lock-free callers ever wait — and a
  // waiter that holds nothing cannot be a node in a wait cycle.
  if (held && held.size > 0) {
    trackDetachedFollowUp(agentId, followUp);
    return options.onCoalesced();
  }
  return followUp;
}

/**
 * Register (or join) the single coalesced follow-up pass for an agent.
 *
 * Every caller that arrives while the lock is held shares one follow-up, so N
 * concurrent wakes produce at most one extra pass rather than N queued passes.
 */
function ensureCoalescedFollowUp<T>(
  agentId: string,
  fn: () => Promise<T>,
  running: Promise<void>,
): Promise<T> {
  const existing = followUpByAgent.get(agentId);
  if (existing) return existing as Promise<T>;

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
 * Keep a handle on a follow-up that no caller is awaiting.
 *
 * Attaching a rejection handler here keeps a failing detached pass from
 * surfacing as an unhandled rejection; the original promise still rejects for
 * anyone who later joins it.
 */
function trackDetachedFollowUp(agentId: string, followUp: Promise<unknown>): void {
  const settled = followUp.then(
    () => undefined,
    (err) => {
      logger.error({ err, agentId }, "detached queued-run dispatch pass failed");
    },
  );
  detachedFollowUps.add(settled);
  void settled.finally(() => detachedFollowUps.delete(settled));
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

/**
 * Test-only: await every dispatch pass that was scheduled without a waiter.
 *
 * A detached pass can itself schedule another, so this loops until the set is
 * empty rather than draining a single snapshot.
 */
export async function _settleDetachedAgentStartLockWorkForTesting(): Promise<void> {
  while (detachedFollowUps.size > 0) {
    await Promise.all([...detachedFollowUps]);
  }
}

/** Test-only: drop all in-process lock state. */
export function _resetAgentStartLocksForTesting() {
  runningByAgent.clear();
  followUpByAgent.clear();
  detachedFollowUps.clear();
}
