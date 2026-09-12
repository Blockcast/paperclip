import type { heartbeatService } from "../../services/heartbeat.ts";

type Heartbeat = ReturnType<typeof heartbeatService>;

/**
 * Polls until the run leaves 'queued'/'running', then returns it.
 *
 * BLO-33449: throws on budget expiry instead of returning the still-running
 * run. Returning it made a wall-clock overrun on a loaded runner surface as a
 * behavioural assertion diff ("expected succeeded, got running"), which reads
 * as "this PR broke run finalization" and costs a full diagnostic cycle.
 */
export async function waitForRunToFinish(heartbeat: Heartbeat, runId: string, timeoutMs = 5_000) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // One last read: the run may have terminated inside the final poll gap.
  const run = await heartbeat.getRun(runId);
  if (run && run.status !== "queued" && run.status !== "running") return run;
  throw new Error(
    `run ${runId} did not reach a terminal status within ${timeoutMs}ms ` +
      `(waited ${Date.now() - startedAt}ms, last status: ${run?.status ?? "missing"})`,
  );
}
