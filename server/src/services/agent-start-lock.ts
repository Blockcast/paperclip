import { AsyncLocalStorage } from "node:async_hooks";

import { logger } from "../middleware/logger.js";
import { recordAgentStartLockAborted } from "./metrics.js";

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
 * that used to self-deadlock and (b) bounding the critical section's work.
 *
 * ⚠️ (b) used to be an expectation rather than an enforced invariant, and
 * PEN-3305 is what that cost: nothing bounded `fn`, the lock was released if
 * and only if `fn` settled, so a section that never settled held its agent's
 * lock for the life of the process. The agent then stopped dispatching while
 * reading `status: idle` / `errorReason: null` / `orgChainHealth: healthy`.
 * Measured 2026-09-15/16: five agents across two companies went dark for 6–19 h
 * each and the outage ended only when the pod was replaced — an in-process lock
 * dies with the process, which is why a restart "fixed" it.
 *
 * PEN-3328 supplies the missing mechanism, and the shape of it is the whole
 * point. Each section gets an `AbortController` whose signal is published on
 * the async path ({@link currentAgentStartLockSignal}); past
 * `LOCK_HELD_ERROR_MS` the signal is aborted, which cancels the section's
 * in-flight database work for real (see `agent-start-lock-db.ts`) so `fn`
 * *rejects* and the lock is released through the `finally` that was already
 * there.
 *
 * What this module deliberately does NOT do is stop awaiting `fn`. There is
 * still no timeout bypass. `runExclusively` awaits `execution` to completion
 * under every outcome, so the next section starts only once the previous one
 * has genuinely settled — aborting or not. That is the difference between this
 * and the BLO-20396 defect: abandoning a still-pending `fn` on a timer would
 * let a follow-up scan and mutate the same queue alongside the holder, and is
 * still not an option here. Cancellation makes `fn` finish; it never makes us
 * stop waiting for it.
 *
 * The liveness reporting from PEN-3305 is retained rather than superseded,
 * because the abort is not guaranteed to land: it can only cancel awaits that
 * observe the signal (today, database work — see the caveat on
 * {@link currentAgentStartLockSignal}). A section wedged on something else
 * still holds its lock, and the escalating `error` log plus
 * {@link describeHeldAgentStartLocks} remain the only thing that reports it.
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
 * Escalate the overrun log from `warn` to `error` — and abort the section
 * (PEN-3305 / PEN-3328) — past this.
 *
 * A section that has held the lock for five minutes is no longer "falling
 * behind" — dispatch for that agent has stopped. Five minutes is well above any
 * legitimate section (the healthy case is sub-second) and well below the hours
 * a real wedge runs for.
 *
 * The log escalation and the abort deliberately share one threshold and one
 * timer tick: the moment we are willing to tell an operator that dispatch has
 * stopped is the moment we should be trying to restart it, and two thresholds
 * would let the log and the remedy disagree about when that is.
 */
const LOCK_HELD_ERROR_MS = 5 * 60_000;

/**
 * How long a recorded abort stays visible on the agent after the fact.
 *
 * The lock releases as soon as the abort lands, so the agent resumes
 * dispatching immediately and a "currently wedged" reading would be gone before
 * anyone looked. Retaining the record is what makes the event answerable after
 * it has self-healed — the failure mode this whole line of work exists to fix
 * was precisely that a dead agent looked identical to an idle one.
 */
const DISPATCH_ABORT_RETENTION_MS = 60 * 60_000;

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
 * When each agent's currently-held section started, for the liveness gauge.
 *
 * Kept in step with {@link runningByAgent} — same key, same lifetime, same
 * marker-identity guard on delete — so the two cannot disagree about whether an
 * agent's lock is held.
 */
const heldSinceByAgent = new Map<string, number>();

/**
 * Follow-up passes that were scheduled without a waiter, because scheduling
 * caller already held another agent's lock (see the deadlock guard below).
 */
const detachedFollowUps = new Set<Promise<unknown>>();

/** Agent ids whose locks are held by the current async execution path. */
const heldAgentIds = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * The abort signal of the critical section running on the current async path.
 *
 * Carried in AsyncLocalStorage rather than threaded as a parameter because the
 * section is one closure spanning ~1200 lines in `heartbeat.ts` that reaches
 * the database through twenty-odd helpers resolving a lexically captured `db`.
 * Threading a signal to every one of them would be a change to most of that
 * file for no added guarantee: the awaits that matter are all database awaits,
 * and they share a single chokepoint (the postgres.js client) that can read the
 * signal ambiently. See `agent-start-lock-db.ts`.
 */
const sectionSignals = new AsyncLocalStorage<AbortSignal>();

/**
 * The abort signal for the dispatch critical section on this async path, if
 * any. `undefined` outside a section — which is the common case, and is why
 * every consumer must treat "no signal" as "not cancellable", never as "already
 * aborted".
 *
 * ⚠️ A signal existing does not make an arbitrary await abortable. It aborts
 * only what actively observes it. Today that is the section's database work,
 * via the wrapper in `agent-start-lock-db.ts`; a section wedged on something
 * else (a socket with no timeout, an unresolved in-process promise) still holds
 * its lock and is reported, not rescued, by {@link describeHeldAgentStartLocks}.
 */
export function currentAgentStartLockSignal(): AbortSignal | undefined {
  return sectionSignals.getStore();
}

/**
 * Rejection raised into a dispatch section whose lock hold passed
 * `LOCK_HELD_ERROR_MS`.
 *
 * Typed rather than a bare `Error` so callers can tell a cancelled dispatch
 * pass apart from a failed one. They are not the same event: a failure means
 * the pass tried something and it did not work, a cancellation means the pass
 * stopped responding and was taken down so the agent could dispatch again.
 */
export class AgentStartLockAbortedError extends Error {
  readonly agentId: string;
  readonly heldMs: number;

  constructor(agentId: string, heldMs: number) {
    super(
      `Queued-run dispatch for agent ${agentId} was aborted after holding the start lock for `
      + `${Math.round(heldMs / 1000)}s (limit ${Math.round(LOCK_HELD_ERROR_MS / 1000)}s).`,
    );
    this.name = "AgentStartLockAbortedError";
    this.agentId = agentId;
    this.heldMs = heldMs;
  }
}

type DispatchAbortRecord = {
  /** When the abort was requested, epoch ms. */
  abortedAtMs: number;
  /** How long the section had held the lock at that point. */
  heldMs: number;
  /**
   * Whether the section actually finished after the abort was requested.
   *
   * False means the abort was raised but nothing in the section observed it —
   * the lock is still held and the agent is still not dispatching. That
   * distinction is the difference between "recovered" and "still down", so it
   * must never be collapsed into a single "aborted" flag.
   */
  released: boolean;
};

/** The most recent abort per agent, retained for `DISPATCH_ABORT_RETENTION_MS`. */
const lastAbortByAgent = new Map<string, DispatchAbortRecord>();

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
  heldSinceByAgent.set(agentId, startedAtMs);

  // Wrap so a synchronous throw from `fn` surfaces as a rejection rather than
  // escaping before the lock bookkeeping below is installed.
  const abort = new AbortController();
  const execution = (async () =>
    heldAgentIds.run(nextHeld, () => sectionSignals.run(abort.signal, fn)))();
  // Settle the marker either way, so a failing section still releases the lock
  // and still lets the coalesced follow-up run.
  void execution.then(settleMarker, settleMarker);

  // Repeating, NOT one-shot (PEN-3305). This was a `setTimeout`, so a section
  // that wedged forever logged exactly one line — at t+30s — and was then
  // invisible for as long as it held the lock. A 16-hour hold and a 31-second
  // one produced identical evidence, which is why a multi-agent, multi-company
  // dispatch outage ran for 19 hours without anything reporting it. Re-logging
  // makes the hold's *duration* readable from the log alone, and escalating
  // past LOCK_HELD_ERROR_MS separates "slow" from "stopped".
  let lastLoggedAtMs = startedAtMs;
  let loggedStopped = false;
  const warnTimer = setInterval(() => {
    const nowMs = Date.now();
    const heldMs = nowMs - startedAtMs;
    const stopped = heldMs >= LOCK_HELD_ERROR_MS;
    // Past the error threshold the section is not coming back on its own, so
    // back the cadence off from 30s to LOCK_HELD_ERROR_MS: a multi-hour wedge
    // should be loud enough to alert on, not thousands of identical lines.
    // Never delay the FIRST error though — that is the line an alert fires on,
    // and gating it behind the backoff would push it ~2x past the threshold.
    if (stopped && loggedStopped && nowMs - lastLoggedAtMs < LOCK_HELD_ERROR_MS) return;
    lastLoggedAtMs = nowMs;
    const fields = { agentId, heldMs, warnAfterMs: LOCK_HELD_WARN_MS };
    if (stopped) {
      // Abort on the FIRST error tick only, and never stop awaiting `execution`
      // because of it (PEN-3328). The abort is a request into the section, not
      // a release of the lock: `fn` still has to settle before the next section
      // starts, so mutual exclusion holds whether the abort lands or not.
      if (!loggedStopped) {
        forgetExpiredAborts(nowMs);
        lastAbortByAgent.set(agentId, { abortedAtMs: nowMs, heldMs, released: false });
        recordAgentStartLockAborted(agentId);
        abort.abort(new AgentStartLockAbortedError(agentId, heldMs));
      }
      loggedStopped = true;
      logger.error(
        { ...fields, errorAfterMs: LOCK_HELD_ERROR_MS, aborted: true },
        "agent start lock held far past its budget; queued-run dispatch for this agent has stopped",
      );
    } else {
      logger.warn(fields, "agent start lock held longer than expected; queued-run dispatch is falling behind");
    }
  }, LOCK_HELD_WARN_MS);
  warnTimer.unref?.();

  try {
    return await execution;
  } finally {
    clearInterval(warnTimer);
    // Reaching here at all means `execution` settled, so if we aborted this
    // section the abort worked. Record that, because "aborted and recovered" and
    // "aborted and still wedged" are the two outcomes an operator needs to tell
    // apart and the request alone cannot distinguish them.
    if (abort.signal.aborted) {
      const record = lastAbortByAgent.get(agentId);
      if (record && !record.released) record.released = true;
    }
    // Identity-guarded: if a later section already took this agent's lock, the
    // map entries are ITS state, not ours, and must not be cleared.
    if (runningByAgent.get(agentId) === marker) {
      runningByAgent.delete(agentId);
      heldSinceByAgent.delete(agentId);
    }
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
 *
 * The section's abort signal is dropped here for the same reason, and the
 * consequence of not dropping it would be worse than a stalled queue: a run
 * launched by a section that later aborts would inherit that section's signal,
 * so the abort would cancel the *run's* database work — tearing down live work
 * that has nothing to do with queue selection.
 */
export function runDetachedFromAgentStartLock<T>(fn: () => T): T {
  return heldAgentIds.exit(() => sectionSignals.exit(fn));
}

/**
 * Drop abort records older than {@link DISPATCH_ABORT_RETENTION_MS}.
 *
 * Called from the write path and from the read path rather than on a timer:
 * the map is only interesting while something is reading or writing it, and a
 * timer would be one more thing to leak in tests.
 */
function forgetExpiredAborts(nowMs: number): void {
  for (const [agentId, record] of lastAbortByAgent) {
    if (nowMs - record.abortedAtMs > DISPATCH_ABORT_RETENTION_MS) lastAbortByAgent.delete(agentId);
  }
}

/**
 * Why this agent is (or recently was) not dispatching, as far as the start lock
 * can tell.
 *
 * `null` is the overwhelmingly common answer and means only that this module
 * has nothing to report — NOT that the agent is healthy. Dispatch can be
 * stopped for reasons the lock never sees.
 */
export type AgentStartLockDispatchHealth = {
  /**
   * - `stalled`  — the lock is held past the budget and the abort has not
   *                landed. The agent is not dispatching *right now*.
   * - `aborted`  — a recent section was cancelled and the lock was released.
   *                The agent is dispatching again; this is the post-mortem.
   */
  status: "stalled" | "aborted";
  heldMs: number;
  abortedAt: string;
  reason: string;
};

/**
 * Report the start lock's view of an agent's dispatch health (PEN-3328).
 *
 * This is the surface that answers Done-when #3: a cancelled section must say
 * *why* dispatch stopped instead of leaving the agent reading `status: idle` /
 * `errorReason: null`, which is exactly how five agents stayed dark for up to
 * 19 hours without anyone being able to name the fault.
 *
 * Synchronous and DB-free on purpose — same argument as
 * {@link describeHeldAgentStartLocks}. It is read from the agent-row
 * normalizer, which is on the request path of every agent read, so it must not
 * be able to block on the very database a wedged section may be stuck on.
 */
export function describeAgentStartLockDispatchHealth(
  agentId: string,
  nowMs: number = Date.now(),
): AgentStartLockDispatchHealth | null {
  forgetExpiredAborts(nowMs);
  const record = lastAbortByAgent.get(agentId);
  if (!record) return null;
  const heldSince = heldSinceByAgent.get(agentId);
  // Still held *and* held since before the abort ⇒ the abort has not landed and
  // this is the same wedged section, not a fresh one that happens to be running.
  const stillWedged = heldSince !== undefined && heldSince <= record.abortedAtMs;
  return {
    status: stillWedged ? "stalled" : "aborted",
    heldMs: stillWedged ? Math.max(0, nowMs - heldSince) : record.heldMs,
    abortedAt: new Date(record.abortedAtMs).toISOString(),
    reason: stillWedged
      ? "Queued-run dispatch has been holding this agent's start lock past its budget and did not "
        + "respond to cancellation. The agent is not dispatching queued runs; replacing the "
        + "control-plane pod clears it."
      : "Queued-run dispatch overran its budget and was cancelled. The start lock was released and "
        + "dispatch has resumed; queued runs were not lost.",
  };
}

/**
 * Snapshot every currently-held agent start lock and how long it has been held.
 *
 * Exported because this module's failure mode is *silence*, not noise
 * (PEN-3305). A wedged section holds its agent's lock forever — there is no
 * timeout, by design (see the header) — and the agent then presents as
 * `status: idle` / `errorReason: null` / `orgChainHealth: healthy` while its
 * queued runs pile up untouched. Measured 2026-09-15/16: five agents across
 * two companies went dark for 6–19 h each, no surface anywhere reported it,
 * and the outage ended only when the control-plane pod was replaced.
 *
 * Deliberately synchronous and DB-free: the caller publishes this on the
 * `/metrics` request path, because a section wedged on a pool acquisition is
 * exactly when a DB-backed collector would itself be stuck and report nothing.
 * Same reasoning as `refreshDbPoolMetrics`.
 */
export function describeHeldAgentStartLocks(): Array<{ agentId: string; heldMs: number }> {
  const nowMs = Date.now();
  const held: Array<{ agentId: string; heldMs: number }> = [];
  for (const [agentId, startedAtMs] of heldSinceByAgent) {
    held.push({ agentId, heldMs: Math.max(0, nowMs - startedAtMs) });
  }
  return held;
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
  heldSinceByAgent.clear();
  lastAbortByAgent.clear();
}
