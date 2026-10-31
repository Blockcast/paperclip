import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { httpMetricsMiddleware } from "../middleware/http-metrics.js";
import {
  HTTP_REQUESTS_METRIC,
  HTTP_REQUEST_DURATION_METRIC,
  __resetMetricsForTest,
  getMetricsRegistry,
  recordHttpRequest,
  renderMetrics,
} from "../services/metrics.js";

/**
 * PEN-5136. Four HTTP instruments existed before this one and all were
 * counters, so no query could state a route's latency at any percentile.
 * Migration 0098's fix regressed from a verified 774ms and nothing observed it
 * walking toward the inherited 30s `statement_timeout`; it surfaced only once
 * it crossed and served a 503 (PEN-3596).
 *
 * These tests pin the three properties that make the histogram trustworthy as
 * a regression detector: it shares the counter's route label exactly, its
 * buckets straddle the 30s bound, and a request the client abandoned never
 * enters the distribution.
 */

type Series = { value: number; labels: Record<string, string | number> };

async function seriesFor(metricName: string): Promise<Series[]> {
  const metric = getMetricsRegistry().getSingleMetric(metricName);
  if (!metric) return [];
  const snapshot = (await metric.get()) as { values: Series[] };
  return snapshot.values;
}

/** The finite bucket edges this family exposes, ascending. */
async function bucketEdges(): Promise<number[]> {
  const values = await seriesFor(HTTP_REQUEST_DURATION_METRIC);
  return values
    .map((s) => String(s.labels.le ?? ""))
    .filter((le) => le !== "" && le !== "+Inf")
    .map(Number)
    .sort((a, b) => a - b);
}

async function observedCount(labels: Record<string, string> = {}): Promise<number> {
  // `_count` is the +Inf bucket's value in prom-client's snapshot shape.
  const values = await seriesFor(HTTP_REQUEST_DURATION_METRIC);
  return values
    .filter(
      (s) =>
        String(s.labels.le) === "+Inf"
        && Object.entries(labels).every(([k, v]) => String(s.labels[k]) === v),
    )
    .reduce((sum, s) => sum + s.value, 0);
}

async function call(
  app: express.Express,
  path: string,
  expectedStatus: number,
  method: "get" | "post" = "get",
) {
  const res = await request(app)[method](path).expect(expectedStatus);
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

function buildApp() {
  const app = express();
  app.use(httpMetricsMiddleware());
  const api = express.Router();
  const rootMounted = express.Router();
  rootMounted.get("/companies/:companyId/issues", (_req, res) => {
    res.json([{ id: "i1" }]);
  });
  rootMounted.get("/companies/:companyId/throws", () => {
    throw Object.assign(new Error("statement timeout"), { status: 503 });
  });
  rootMounted.post("/companies/:companyId/issues", (_req, res) => {
    res.status(201).json({ id: "i2" });
  });
  api.use(rootMounted);
  app.use("/api", api);
  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });
  app.use(
    (
      err: Error & { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.status ?? 500).json({ error: err.message });
    },
  );
  return app;
}

describe("per-route HTTP request-duration histogram (PEN-5136)", () => {
  beforeEach(() => {
    __resetMetricsForTest();
  });
  afterEach(() => {
    __resetMetricsForTest();
  });

  it("observes a completed response under the same route template the counter uses", async () => {
    await call(buildApp(), "/api/companies/c1/issues", 200);

    expect(
      await observedCount({ route: "/api/companies/:companyId/issues", method: "GET" }),
    ).toBe(1);
  });

  /**
   * The histogram is fed from the same `recordHttpRequest` call as the
   * counters precisely so the two can never disagree about a route's name --
   * including on the throwing path, where Express has already restored
   * `req.baseUrl` and a second call site would derive a different label.
   */
  it("keeps the mount prefix on a route that throws, matching the counter", async () => {
    await call(buildApp(), "/api/companies/c1/throws", 503);

    const route = "/api/companies/:companyId/throws";
    expect(await observedCount({ route, method: "GET" })).toBe(1);
    const counter = (await seriesFor(HTTP_REQUESTS_METRIC)).filter(
      (s) => String(s.labels.route) === route,
    );
    expect(counter).toHaveLength(1);
  });

  it("does not carry a status label, so one route is one series per bucket", async () => {
    const app = buildApp();
    await call(app, "/api/companies/c1/issues", 200);
    await call(app, "/api/companies/c1/throws", 503);

    const values = await seriesFor(HTTP_REQUEST_DURATION_METRIC);
    expect(values.length).toBeGreaterThan(0);
    for (const s of values) {
      expect(s.labels).not.toHaveProperty("status");
      expect(s.labels).not.toHaveProperty("code");
    }
    // Two routes, each observed once, and no status split between them.
    expect(await observedCount({ route: "/api/companies/:companyId/issues" })).toBe(1);
    expect(await observedCount({ route: "/api/companies/:companyId/throws" })).toBe(1);
  });

  it("does not mint a series per path parameter", async () => {
    const app = buildApp();
    for (const id of ["c1", "c2", "c3", "c4"]) {
      await call(app, `/api/companies/${id}/issues`, 200);
    }

    expect(
      await observedCount({ route: "/api/companies/:companyId/issues", method: "GET" }),
    ).toBe(4);
  });

  /**
   * `method` is the one label kept beside `route`, and this is what it buys: a
   * list GET and a create POST share one route template but are different work
   * with different expected latencies. Collapsing them would average a cheap
   * write into a read's distribution, which is the quantity being watched.
   */
  it("separates methods sharing one route template", async () => {
    const app = buildApp();
    await call(app, "/api/companies/c1/issues", 200, "get");
    await call(app, "/api/companies/c1/issues", 201, "post");

    const route = "/api/companies/:companyId/issues";
    expect(await observedCount({ route, method: "GET" })).toBe(1);
    expect(await observedCount({ route, method: "POST" })).toBe(1);
  });

  /**
   * The bound this metric exists to straddle. Without an `le="30"` edge,
   * "is this route still answering inside the inherited statement_timeout?"
   * is not a directly queryable quantity -- which is the gap that let 0098's
   * regression run to an outage before anything noticed.
   */
  it("places bucket edges that straddle the inherited 30s statement_timeout", async () => {
    await call(buildApp(), "/api/companies/c1/issues", 200);

    const edges = await bucketEdges();

    expect(edges).toContain(30);
    // An edge below and above the bound, so "inside" and "outran it" are both
    // measurable rather than collapsing into the +Inf tail.
    expect(edges.some((e) => e < 30)).toBe(true);
    expect(edges.some((e) => e > 30)).toBe(true);
    // Sub-second resolution, where ordinary traffic and 0098's 774ms baseline
    // live.
    expect(edges.some((e) => e <= 1)).toBe(true);
  });

  it("exposes the histogram family under the documented metric name", async () => {
    await call(buildApp(), "/api/companies/c1/issues", 200);

    const { body: rendered } = await renderMetrics();
    expect(rendered).toContain(`${HTTP_REQUEST_DURATION_METRIC}_bucket`);
    expect(rendered).toContain(`${HTTP_REQUEST_DURATION_METRIC}_sum`);
    expect(rendered).toContain(`${HTTP_REQUEST_DURATION_METRIC}_count`);
    expect(rendered).toContain(`# TYPE ${HTTP_REQUEST_DURATION_METRIC} histogram`);
  });

  /**
   * The property that keeps every percentile honest. An abandoned request
   * stopped when the client gave up, not when the work finished, so its
   * elapsed time is truncated from above and concentrates in the slow tail --
   * exactly where this metric is read. It stays fully visible as `status="0"`
   * on the counter, which owns that regime.
   */
  it("excludes a client-aborted request from the distribution while the counter keeps it", async () => {
    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }
    const arrived = deferred();
    const closed = deferred();
    const app = express();
    app.use(httpMetricsMiddleware());
    app.get("/hangs", (_req, res) => {
      res.once("close", closed.resolve);
      arrived.resolve();
      // Never responds: the shape of a request stuck on an exhausted pool.
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const clientReq = http.get({ host: "127.0.0.1", port, path: "/hangs" });
      clientReq.on("error", () => {
        // The abort surfaces client-side as a socket hang up.
      });
      await arrived.promise;
      clientReq.destroy();
      await closed.promise;
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }

    // The counter records it on the "0" sentinel ...
    const counter = (await seriesFor(HTTP_REQUESTS_METRIC)).filter(
      (s) => String(s.labels.route) === "/hangs",
    );
    expect(counter).toHaveLength(1);
    expect(String(counter[0]?.labels.status)).toBe("0");
    // ... and the histogram mints no series for it at all.
    expect(await seriesFor(HTTP_REQUEST_DURATION_METRIC)).toHaveLength(0);
  });

  describe("recordHttpRequest duration guard", () => {
    /**
     * A histogram `_sum` cannot be un-observed, so a single NaN or negative
     * elapsed would corrupt every quantile on that route for the lifetime of
     * the process. The guard is what makes the clock choice in the middleware
     * a defence in depth rather than the only defence.
     */
    it.each([
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["negative", -1],
    ])("ignores a %s duration rather than corrupting the sum", async (_name, value) => {
      const result = recordHttpRequest({
        route: "/api/thing",
        method: "GET",
        status: 200,
        emptyList: false,
        durationSeconds: value,
      });

      expect(result.durationSeconds).toBeNull();
      expect(await seriesFor(HTTP_REQUEST_DURATION_METRIC)).toHaveLength(0);
      // The counter is unaffected -- a bad clock must not lose the request.
      expect(await seriesFor(HTTP_REQUESTS_METRIC)).toHaveLength(1);
    });

    it("observes a zero duration rather than discarding it", async () => {
      const result = recordHttpRequest({
        route: "/api/thing",
        method: "GET",
        status: 200,
        emptyList: false,
        durationSeconds: 0,
      });

      expect(result.durationSeconds).toBe(0);
      expect(await observedCount({ route: "/api/thing", method: "GET" })).toBe(1);
    });

    it("mints no histogram series when no duration is supplied", async () => {
      recordHttpRequest({
        route: "/api/thing",
        method: "GET",
        status: 200,
        emptyList: false,
      });

      expect(await seriesFor(HTTP_REQUEST_DURATION_METRIC)).toHaveLength(0);
      expect(await seriesFor(HTTP_REQUESTS_METRIC)).toHaveLength(1);
    });
  });
});
