/**
 * API-pipeline wedge detector for the liveness probe (BLO-40591).
 *
 * ## The gap this closes
 *
 * On 2026-10-05 `https://paperclip.blockcast.net/api/*` served **zero bytes
 * for ~29 minutes** and `paperclip-0` read `1/1 Running`, `Ready: True`,
 * `restartCount: 0` for the whole window. All three probes targeted
 * `/healthz`, which is mounted ahead of `httpLogger`, the private-hostname
 * guard, `actorMiddleware` and the `/api` router — so it answers from a point
 * *upstream of everything that can wedge*. It is structurally incapable of
 * reporting on the API pipeline, and it was the only automatic recovery the
 * control plane had.
 *
 * ## Why this is not just "probe the database"
 *
 * That is the obvious fix and the chart forbids it, twice, with measurement
 * (BLO-32164, re-affirmed by BLO-35948): under pool saturation on 2026-09-10
 * `/api/health` took **13.19s** while `/healthz` answered in **6ms** in the
 * same second. Putting a query on the liveness path imports that stall into a
 * kill decision and restarts the singleton worker — and every in-flight agent
 * run on it — for a latency problem. BLO-35948 is the right half of the split:
 * *readiness* targets `/api/health`, so a dead pool goes NotReady. Readiness
 * does not restart anything, which is why the 29-minute window stayed
 * unbounded.
 *
 * ## The discriminator
 *
 * The two regimes differ in a way a DB check cannot see:
 *
 *   - pool saturation — requests complete, **slowly** (13.19s)
 *   - a wedge         — requests arrive and **never complete at all**
 *
 * So this keys on completions, not on latency and not on any dependency:
 * *requests are arriving and nothing has completed for `stallMs`*. Saturation
 * keeps completing something and stays green; a wedge goes red.
 *
 * ## Why "last completion", not "oldest request in flight"
 *
 * An oldest-in-flight rule would fire on one long-lived connection — an SSE
 * stream, a log tail — that is behaving exactly as designed. Requiring *zero*
 * completions in the window means a single slow request can never trip it
 * while any other traffic is being served.
 *
 * ## The readiness probe is load-bearing for that
 *
 * `/api` does serve long-lived streams (board chat, plugin and MCP transports),
 * so "any other traffic" has to be guaranteed, not assumed: a lone open stream
 * on an otherwise silent instance is the one shape that could trip this
 * wrongly. Worker *readiness* targets `/api/health` every 20s (BLO-35948), so a
 * healthy instance completes an `/api` response three times a minute no matter
 * how quiet it is, and only an instance that cannot answer that either can
 * reach the window. Point readiness back at `/healthz` and that guarantee is
 * gone — `deploy/helm/paperclip/tests/probes.test.mjs` pins it.
 *
 * It also makes readiness `timeoutSeconds` (20s), not `stallMs`, this
 * detector's real saturation margin: about 1.5x the 13.19s worst non-wedge
 * sample. kubelet abandons a probe at its timeout, so an `/api/health` slower
 * than that counts as an arrival without a completion. Three of those (~60s)
 * remove the only Service endpoint, the probe is then the only `/api` traffic
 * left, and a saturation episode that keeps `/api/health` above 20s for the
 * window reads as a wedge and restarts the worker. The same test file pins
 * the 20s floor.
 *
 * The same guarantee is this detector's sharpest blind spot, and it is the
 * other half of the same sentence: `wedged` requires *zero* completions, so
 * any wedge that still answers `/api/health` inside its timeout is
 * undetectable by construction — the probe refreshes the completion clock
 * three times a minute and `/livez` cannot go red. `/api/health` is the
 * shallowest `/api` route there is, so it is the request least likely to
 * share a partial wedge's fate. This detector is scoped to the 2026-10-05
 * shape, where `/api/*` served zero bytes; a partial wedge was invisible
 * before it and still is.
 *
 * ## Why an idle instance stays green
 *
 * The arrival timestamp only advances past the completion timestamp while a
 * request is outstanding. When traffic stops after a normal response,
 * `lastResponseCompletedAt` is the later of the two and stays later forever,
 * so silence reads as healthy however long it lasts.
 *
 * ## Only genuine completions count
 *
 * `res.writableFinished` is load-bearing. During the incident, external
 * clients timed out at 25s and their sockets closed, which fires `close` on
 * the response. Counting that as a completion would have refreshed this clock
 * every few seconds and the probe would never have gone red — the detector
 * would have been defeated by the very failure it exists to catch. An
 * abandoned response is recorded on the `0` status sentinel by
 * `recordHttpRequest`; it is not a completion here either.
 */

/**
 * No completed `/api` response for this long, while requests are outstanding,
 * is a wedge. Deliberately far above the 13.19s pool-saturation tail measured
 * on 2026-09-10, so saturation cannot reach it while `/api/health` answers
 * inside the readiness timeout (see above), and far below the ~29 minutes
 * the 2026-10-05 wedge ran unattended. With the worker liveness probe at
 * `periodSeconds: 30, failureThreshold: 6`, a restart lands ~3-6 minutes into
 * a wedge.
 */
export const API_PIPELINE_STALL_MS = 180_000;

/**
 * Boot state. The completion clock is seeded to *now* rather than 0 because
 * `now - 0` is the whole Unix epoch: with a zero seed the very first request
 * to arrive would read as an instant wedge, before it had any chance to
 * finish, and a cold start under load would 503 its own liveness probe. There
 * is one initializer for this, shared with the reset below, so the boot path
 * and the path the tests exercise cannot drift apart.
 */
let lastResponseCompletedAt = 0;
let lastRequestReceivedAt = 0;

/** Call when an `/api` request enters the pipeline. */
export function noteApiRequestReceived(nowMs: number = Date.now()): void {
  lastRequestReceivedAt = nowMs;
}

/** Call only when an `/api` response actually finished writing. */
export function noteApiResponseCompleted(nowMs: number = Date.now()): void {
  lastResponseCompletedAt = nowMs;
}

export type ApiPipelineStatus = {
  wedged: boolean;
  /** ms since the last genuinely completed `/api` response. */
  sinceLastCompletionMs: number;
  /** True while at least one `/api` request has arrived since that completion. */
  requestOutstanding: boolean;
};

export function inspectApiPipeline(
  nowMs: number = Date.now(),
  stallMs: number = API_PIPELINE_STALL_MS,
): ApiPipelineStatus {
  const sinceLastCompletionMs = Math.max(0, nowMs - lastResponseCompletedAt);
  const requestOutstanding = lastRequestReceivedAt > lastResponseCompletedAt;
  return {
    wedged: requestOutstanding && sinceLastCompletionMs >= stallMs,
    sinceLastCompletionMs,
    requestOutstanding,
  };
}

/** Returns the module to its boot state at `nowMs`. Called once at load, and
 * by tests. */
export function resetApiPipelineLiveness(nowMs: number = Date.now()): void {
  lastResponseCompletedAt = nowMs;
  lastRequestReceivedAt = 0;
}

resetApiPipelineLiveness();
