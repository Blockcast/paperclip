/**
 * BLO-49596. Upper bound on the graceful wait for in-flight scheduler work
 * before the scheduler lease is released. Unbounded, a long recovery pass
 * outlived the 120 s termination grace, the holder was SIGKILLed while still
 * renewing, and the survivor waited out grace + TTL (~160 s measured). 20 s
 * keeps preStop (5 s) + this + one follower poll well inside the 60 s
 * failover budget. In-flight passes stop cooperatively at SIGTERM, so this is
 * a backstop: when it fires, the lease is released with some work possibly
 * still running — speed is chosen over exclusion for that residual.
 */
export const HEARTBEAT_SCHEDULER_IDLE_WAIT_TIMEOUT_MS = 20_000;

type HotRestartShutdownPreparation = {
  skipDrain: boolean;
};

export async function coordinateHeartbeatSchedulerShutdown<
  TPreparation extends HotRestartShutdownPreparation,
>(input: {
  signal: "SIGINT" | "SIGTERM";
  prepareHotRestartShutdown: ((signal: "SIGINT" | "SIGTERM") => Promise<TPreparation>) | null;
  waitForHeartbeatSchedulerIdle: () => Promise<void>;
  idleWaitTimeoutMs?: number;
}): Promise<{
  hotRestart: TPreparation | null;
  preparationError: unknown;
  waitedForSchedulerIdle: boolean;
  idleWaitTimedOut: boolean;
}> {
  let hotRestart: TPreparation | null = null;
  let preparationError: unknown = null;

  if (input.prepareHotRestartShutdown) {
    try {
      hotRestart = await input.prepareHotRestartShutdown(input.signal);
    } catch (err) {
      preparationError = err;
    }
  }

  if (hotRestart?.skipDrain) {
    return {
      hotRestart,
      preparationError,
      waitedForSchedulerIdle: false,
      idleWaitTimedOut: false,
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = await Promise.race([
    input.waitForHeartbeatSchedulerIdle().then(() => true),
    ...(input.idleWaitTimeoutMs === undefined
      ? []
      : [new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), input.idleWaitTimeoutMs); })]),
  ]).finally(() => clearTimeout(timer));
  return {
    hotRestart,
    preparationError,
    waitedForSchedulerIdle: idle,
    idleWaitTimedOut: !idle,
  };
}

/**
 * BLO-49139. `server.close()` waits for every open connection, so one
 * long-lived request could starve the heartbeat run drain of the grace period.
 * After `timeoutMs`, force-close whatever is left and let close resolve.
 */
export function closeServerBounded(
  server: {
    close(cb: (err?: Error) => void): unknown;
    closeIdleConnections?(): void;
    closeAllConnections?(): void;
  },
  timeoutMs: number,
  onForceClose: () => void,
): Promise<Error | undefined> {
  return new Promise((resolve) => {
    const forceClose = setTimeout(() => {
      onForceClose();
      server.closeAllConnections?.();
    }, timeoutMs);
    forceClose.unref?.();
    server.close((err) => {
      clearTimeout(forceClose);
      resolve(err);
    });
    server.closeIdleConnections?.();
  });
}
