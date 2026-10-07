import type { NextFunction, Request, Response } from "express";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";

import { httpMetricsMiddleware } from "../middleware/http-metrics.js";
import {
  API_PIPELINE_STALL_MS,
  inspectApiPipeline,
  noteApiRequestReceived,
  noteApiResponseCompleted,
  resetApiPipelineLiveness,
} from "../services/api-pipeline-liveness.js";

/**
 * BLO-40591. This detector decides whether to restart the singleton control
 * plane, so both error directions are expensive and both are pinned here:
 * failing to fire leaves an unbounded outage (the 29-minute 2026-10-05 wedge),
 * and firing wrongly kills every in-flight agent run for a latency blip that
 * BLO-32164/BLO-35948 measured at 13.19s.
 */

const T0 = 1_700_000_000_000;

describe("API pipeline wedge detector", () => {
  beforeEach(() => resetApiPipelineLiveness(T0));

  it("reports healthy on a silent instance, however long the silence", () => {
    // No requests at all since boot. The arrival clock never passes the
    // completion clock, so idleness can never age into a wedge.
    expect(inspectApiPipeline(T0 + 86_400_000).wedged).toBe(false);
  });

  it("does not call a freshly-booted instance wedged on its first in-flight request", () => {
    // The boot state is the one `resetApiPipelineLiveness` reproduces, so this
    // pins the module's own initializer too. With the completion clock seeded
    // at 0 instead of boot, `now - 0` is the whole Unix epoch and the first
    // request to arrive reads as an instant wedge — a cold start under load
    // would 503 its own liveness probe before serving anything.
    noteApiRequestReceived(T0 + 50);

    expect(inspectApiPipeline(T0 + 50).wedged).toBe(false);
    expect(inspectApiPipeline(T0 + API_PIPELINE_STALL_MS - 1).wedged).toBe(false);
    expect(inspectApiPipeline(T0 + API_PIPELINE_STALL_MS).wedged).toBe(true);
  });

  it("reports healthy while requests complete, even slowly", () => {
    // The BLO-32164 regime: 13.19s per request under pool saturation. Slow is
    // not wedged, and a probe that cannot tell them apart must not restart.
    for (let t = 0; t < 600_000; t += 13_190) {
      noteApiRequestReceived(T0 + t);
      noteApiResponseCompleted(T0 + t + 13_190);
      expect(inspectApiPipeline(T0 + t + 13_190).wedged).toBe(false);
    }
  });

  it("reports healthy after traffic stops following a normal response", () => {
    noteApiRequestReceived(T0 + 1_000);
    noteApiResponseCompleted(T0 + 1_100);

    expect(inspectApiPipeline(T0 + 1_100 + API_PIPELINE_STALL_MS * 10).wedged).toBe(false);
  });

  it("reports wedged once requests arrive and nothing completes for the window", () => {
    noteApiRequestReceived(T0 + 1_000);
    noteApiResponseCompleted(T0 + 1_100);

    // Arrivals keep coming — the readiness probe alone hits /api/health every
    // 20s — and none of them finishes.
    for (let t = 2_000; t < API_PIPELINE_STALL_MS + 60_000; t += 20_000) {
      noteApiRequestReceived(T0 + t);
    }

    expect(inspectApiPipeline(T0 + 1_100 + API_PIPELINE_STALL_MS - 1).wedged).toBe(false);
    expect(inspectApiPipeline(T0 + 1_100 + API_PIPELINE_STALL_MS).wedged).toBe(true);
  });

  it("recovers as soon as one response completes", () => {
    noteApiRequestReceived(T0 + 1_000);
    const wedgedAt = T0 + 1_000 + API_PIPELINE_STALL_MS;
    expect(inspectApiPipeline(wedgedAt).wedged).toBe(true);

    noteApiResponseCompleted(wedgedAt);
    expect(inspectApiPipeline(wedgedAt).wedged).toBe(false);
  });
});

/** Minimal Express-shaped request/response pair; `res` only has to emit. */
function fakeExchange(path: string) {
  const res = new EventEmitter() as unknown as Response & { writableFinished: boolean };
  Object.assign(res, {
    writableFinished: false,
    statusCode: 200,
    json: (body: unknown) => body,
  });
  const req = { path, method: "GET", baseUrl: "", route: undefined } as unknown as Request;
  return { req, res };
}

describe("httpMetricsMiddleware wedge-clock wiring", () => {
  beforeEach(() => resetApiPipelineLiveness(T0));

  it("does not count an abandoned response as a completion", () => {
    // The trap this detector would otherwise walk into. During the incident
    // external clients timed out at 25s and their sockets closed, which fires
    // `close` on the response. If `close` refreshed the completion clock, the
    // wedge would have kept the probe green using its own victims' timeouts.
    const { req, res } = fakeExchange("/api/issues");
    httpMetricsMiddleware()(req, res, (() => {}) as NextFunction);
    // Re-seed AFTER the middleware has run: entry stamps the arrival clock
    // with the real wall clock, which would otherwise swamp the fixture times.
    resetApiPipelineLiveness(T0);

    res.writableFinished = false;
    res.emit("close");

    noteApiRequestReceived(T0 + 1_000);
    expect(inspectApiPipeline(T0 + 1_000 + API_PIPELINE_STALL_MS).wedged).toBe(true);
  });

  it("counts a finished response as a completion", () => {
    // Control: without this the assertion above is vacuous — it would pass
    // just as well if the middleware never recorded a completion at all.
    const { req, res } = fakeExchange("/api/issues");
    httpMetricsMiddleware()(req, res, (() => {}) as NextFunction);
    // Re-seed AFTER the middleware has run: entry stamps the arrival clock
    // with the real wall clock, which would otherwise swamp the fixture times.
    resetApiPipelineLiveness(T0);

    res.writableFinished = true;
    res.emit("finish");

    noteApiRequestReceived(T0 + 1_000);
    expect(inspectApiPipeline(T0 + 1_000 + API_PIPELINE_STALL_MS).wedged).toBe(false);
  });

  it("ignores non-API traffic", () => {
    // Static assets and the SPA catch-all are served upstream of everything
    // that wedges, so letting them mark completions would hold the probe green
    // through an API outage while the UI shell still rendered.
    const { req, res } = fakeExchange("/assets/index.js");
    httpMetricsMiddleware()(req, res, (() => {}) as NextFunction);
    // Re-seed AFTER the middleware has run: entry stamps the arrival clock
    // with the real wall clock, which would otherwise swamp the fixture times.
    resetApiPipelineLiveness(T0);

    res.writableFinished = true;
    res.emit("finish");

    noteApiRequestReceived(T0 + 1_000);
    expect(inspectApiPipeline(T0 + 1_000 + API_PIPELINE_STALL_MS).wedged).toBe(true);
  });
});
