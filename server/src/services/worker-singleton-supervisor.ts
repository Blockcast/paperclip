import { logger } from "../middleware/logger.js";
import { SCHEDULER_LEASE_RENEW_INTERVAL_MS } from "./scheduler-lease.js";

/**
 * A chosen wall-clock phase for a supervised loop's FIRST tick (PEN-6750).
 *
 * `offsetMs` into every `periodMs` window of UTC epoch time. A loop whose own
 * interval divides or is a multiple of `periodMs` then holds that phase for
 * every subsequent tick, because `setInterval` preserves phase.
 */
export type WorkerSingletonStartPhase = {
  /** Alignment grid, in ms. The first tick is pinned to a multiple of this. */
  periodMs: number;
  /** Offset into the grid, in ms. Values outside `[0, periodMs)` wrap. */
  offsetMs: number;
};

/**
 * Milliseconds from `nowMs` until the next instant matching `phase`. Zero when
 * `nowMs` already sits exactly on it, and zero for a non-positive `periodMs`,
 * so a malformed phase degrades to "start now" rather than never starting.
 */
export function msUntilPhase(
  nowMs: number,
  { periodMs, offsetMs }: WorkerSingletonStartPhase,
): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) return 0;
  const into = (((nowMs - offsetMs) % periodMs) + periodMs) % periodMs;
  return into === 0 ? 0 : periodMs - into;
}

type WorkerSingletonScheduler = {
  setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (t: ReturnType<typeof setInterval>) => void;
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (t: ReturnType<typeof setTimeout>) => void;
};

/**
 * The timers are looked up on the global object on every call, not captured
 * once when this module is imported. Writing this object as
 * `{ setInterval, clearInterval, ... }` binds each function at import time,
 * which silently defeats a `vi.spyOn(globalThis, "setInterval")` installed
 * afterwards: the supervisor keeps calling the real timer while the test
 * believes it is driving a hand-run clock, and the test then fails claiming
 * the supervised loop never started (PEN-6750).
 */
const defaultScheduler: WorkerSingletonScheduler = {
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (t) => clearInterval(t),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (t) => clearTimeout(t),
};

/**
 * Run a worker-tier singleton loop only while this process holds the scheduler
 * lease (BLO-46694).
 *
 * The heartbeat timer was made safe for `replicas: 2` by BLO-43292 / BLO-45212
 * / BLO-45763. Every other worker-tier singleton — DB backup, the reconcilers,
 * the isolation reaper, the ageing digest, the Linear tunnel, the plugin job
 * scheduler and event outbox — was still gated on `paperclipNodeRole` alone, so
 * a second worker would run each of them twice.
 *
 * `shouldRun` is re-read every {@link SCHEDULER_LEASE_RENEW_INTERVAL_MS}, not
 * once at boot: a follower that takes the lease over starts the loop, and a
 * holder that loses it stops the loop. `start` returns the loop's own stop
 * function (or nothing, for a one-shot task). It is re-invoked on every
 * re-acquisition, so a one-shot task must be idempotent.
 *
 * Bound on overlap: `stop` only cancels future ticks; a pass already in flight
 * finishes. Since the old holder only demotes after its lease lapses, a new
 * holder's first pass can overlap the old holder's last one. That is the same
 * bound the heartbeat loop itself has, and every loop gated here re-checks its
 * predicate at write time.
 *
 * PEN-6750 — `startPhase`. Without it the loop's phase is whatever minute the
 * lease was acquired at, i.e. whatever minute the leader pod happened to start,
 * re-rolled on every deploy. That accident decides which part of the GitHub
 * rate-limit window a GitHub-reading sweep lands in, and the budget curve
 * inside a window is steeply monotone. With it the first tick is deferred to
 * the next instant matching the phase, which:
 *
 *   - pins the loop to a STATED minute-of-hour rather than an inherited one,
 *   - lets sibling loops with the same interval be staggered rather than fired
 *     at the same instant forever, and
 *   - costs at most one `periodMs` of delay before the first tick after a
 *     restart or a lease hand-over. Choose `periodMs` with that in mind.
 *
 * The lease is re-read when the phase elapses, so a holder that lost the lease
 * while waiting does not start. `startPhase` is omitted — and the behaviour is
 * byte-for-byte the pre-PEN-6750 immediate start — for every loop that has no
 * reason to care which minute it runs at.
 */
export function superviseWorkerSingleton(
  name: string,
  shouldRun: () => boolean,
  start: () => (() => void) | void,
  {
    checkIntervalMs = SCHEDULER_LEASE_RENEW_INTERVAL_MS,
    scheduler = defaultScheduler,
    startPhase = null,
    now = Date.now,
  }: {
    checkIntervalMs?: number;
    scheduler?: WorkerSingletonScheduler;
    startPhase?: WorkerSingletonStartPhase | null;
    now?: () => number;
  } = {},
): () => void {
  let stop: (() => void) | null = null;
  let pendingStart: ReturnType<typeof setTimeout> | null = null;
  let loggedFollower = false;

  const readShouldRun = () => {
    try {
      return shouldRun();
    } catch (err) {
      logger.error({ err, singleton: name }, "worker singleton lease check failed");
      return false;
    }
  };

  const beginLoop = () => {
    try {
      stop = start() ?? (() => {});
      logger.info({ singleton: name }, "worker singleton started on the scheduler lease holder");
    } catch (err) {
      // Leave `stop` null so the next check retries.
      stop = null;
      logger.error({ err, singleton: name }, "worker singleton failed to start");
    }
  };

  const cancelPendingStart = () => {
    if (!pendingStart) return false;
    scheduler.clearTimeout(pendingStart);
    pendingStart = null;
    return true;
  };

  const check = () => {
    const run = readShouldRun();
    if (run && !stop && !pendingStart) {
      loggedFollower = false;
      const delayMs = startPhase ? msUntilPhase(now(), startPhase) : 0;
      if (delayMs <= 0) {
        beginLoop();
        return;
      }
      logger.info(
        {
          singleton: name,
          delayMs,
          periodMs: startPhase?.periodMs,
          offsetMs: startPhase?.offsetMs,
        },
        "worker singleton start deferred to its chosen tick phase",
      );
      const timer = scheduler.setTimeout(() => {
        pendingStart = null;
        // The lease can lapse while we wait the phase out; re-read it rather
        // than starting a singleton this process is no longer the holder for.
        if (!readShouldRun()) {
          logger.warn(
            { singleton: name },
            "worker singleton tick phase elapsed without the scheduler lease - not starting",
          );
          return;
        }
        beginLoop();
      }, delayMs);
      (timer as { unref?: () => void }).unref?.();
      pendingStart = timer;
    } else if (!run && (stop || pendingStart)) {
      const hadPendingStart = cancelPendingStart();
      const s = stop;
      stop = null;
      if (s) {
        try {
          s();
        } catch (err) {
          logger.error({ err, singleton: name }, "worker singleton failed to stop");
        }
        logger.warn({ singleton: name }, "worker singleton stopped - scheduler lease lost");
      } else if (hadPendingStart) {
        logger.warn(
          { singleton: name },
          "worker singleton deferred start cancelled - scheduler lease lost",
        );
      }
    } else if (!run && !loggedFollower) {
      loggedFollower = true;
      logger.info({ singleton: name }, "worker singleton skipped - not the scheduler lease holder");
    }
  };

  check();
  const timer = scheduler.setInterval(check, checkIntervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => {
    scheduler.clearInterval(timer);
    cancelPendingStart();
    stop?.();
    stop = null;
  };
}
