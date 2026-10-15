import { logger } from "../middleware/logger.js";
import { SCHEDULER_LEASE_RENEW_INTERVAL_MS } from "./scheduler-lease.js";

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
 */
export function superviseWorkerSingleton(
  name: string,
  shouldRun: () => boolean,
  start: () => (() => void) | void,
  {
    checkIntervalMs = SCHEDULER_LEASE_RENEW_INTERVAL_MS,
    scheduler = { setInterval, clearInterval } as {
      setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
      clearInterval: (t: ReturnType<typeof setInterval>) => void;
    },
  } = {},
): () => void {
  let stop: (() => void) | null = null;
  let loggedFollower = false;

  const check = () => {
    let run: boolean;
    try {
      run = shouldRun();
    } catch (err) {
      logger.error({ err, singleton: name }, "worker singleton lease check failed");
      run = false;
    }
    if (run && !stop) {
      loggedFollower = false;
      try {
        stop = start() ?? (() => {});
        logger.info({ singleton: name }, "worker singleton started on the scheduler lease holder");
      } catch (err) {
        // Leave `stop` null so the next check retries.
        logger.error({ err, singleton: name }, "worker singleton failed to start");
      }
    } else if (!run && stop) {
      const s = stop;
      stop = null;
      try {
        s();
      } catch (err) {
        logger.error({ err, singleton: name }, "worker singleton failed to stop");
      }
      logger.warn({ singleton: name }, "worker singleton stopped - scheduler lease lost");
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
    stop?.();
    stop = null;
  };
}
