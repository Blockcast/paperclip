import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { httpMetricsMiddleware } from "../middleware/http-metrics.js";
import {
  HTTP_REQUESTS_METRIC,
  HTTP_REQUEST_DURATION_BUCKETS_SECONDS,
  HTTP_REQUEST_DURATION_METRIC,
  HTTP_ROUTE_UNMATCHED,
  __resetMetricsForTest,
  getMetricsRegistry,
  recordHttpRequest,
  renderMetrics,
} from "../services/metrics.js";

/**
 * PEN-5136. Before this histogram existed, every HTTP-route instrument in the
 * process was a counter, so a route's latency regression was invisible until
 * it crossed the inherited 30s `statement_timeout` and served a 503 -- the
 * exact way PEN-3596's regression of migration 0098 surfaced.
 *
 * These tests pin the three properties that make it usable and keep it
 * affordable: the bound is an actual bucket edge, `status` is NOT a label, and
 * a clock fault cannot poison a monotonic `_sum`.
 */

type Series = { value: number; labels: Record<string, string | number>; metricName?: string };

async function seriesFor(metricName: string): Promise<Series[]> {
  const metric = getMetricsRegistry().getSingleMetric(metricName);
  if (!metric) return [];
  const snapshot = (await metric.get()) as { values: Series[] };
  return snapshot.values;
}

/** The `_count` series for one route/method pair: how many observations landed. */
async function observationCount(labels: Record<string, string>): Promise<number> {
  const values = await seriesFor(HTTP_REQUEST_DURATION_METRIC);
  return values
    .filter((s) => s.metricName === `${HTTP_REQUEST_DURATION_METRIC}_count`)
    .filter((s) => Object.entries(labels).every(([k, v]) => String(s.labels[k]) === v))
    .reduce((sum, s) => sum + s.value, 0);
}

/** The `_sum` series for one route/method pair, in seconds. */
async function observationSum(labels: Record<string, string>): Promise<number> {
  const values = await seriesFor(HTTP_REQUEST_DURATION_METRIC);
  return values
    .filter((s) => s.metricName === `${HTTP_REQUEST_DURATION_METRIC}_sum`)
    .filter((s) => Object.entries(labels).every(([k, v]) => String(s.labels[k]) === v))
    .reduce((sum, s) => sum + s.value, 0);
}

/** Cumulative count at a bucket edge, as Prometheus reports it. */
async function bucketAt(le: string, labels: Record<string, string>): Promise<number> {
  const values = await seriesFor(HTTP_REQUEST_DURATION_METRIC);
  return values
    .filter((s) => s.metricName === `${HTTP_REQUEST_DURATION_METRIC}_bucket`)
    .filter((s) => String(s.labels.le) === le)
    .filter((s) => Object.entries(labels).every(([k, v]) => String(s.labels[k]) === v))
    .reduce((sum, s) => sum + s.value, 0);
}

function buildApp() {
  const app = express();
  app.use(httpMetricsMiddleware());

  const api = express.Router();
  const routes = express.Router();
  routes.get("/companies/:companyId/issues", (_req, res) => {
    res.json([{ id: "i1" }]);
  });
  routes.patch("/companies/:companyId/issues", (_req, res) => {
    res.json({ ok: true });
  });
  routes.get("/companies/:companyId/throws", () => {
    throw Object.assign(new Error("pool exhausted"), { status: 503 });
  });
  api.use(routes);
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

/** Issue a request, then yield so the `finish`/`close` latch has run. */
async function call(
  app: express.Express,
  method: "get" | "patch",
  path: string,
  expectedStatus: number,
) {
  await request(app)[method](path).expect(expectedStatus);
  await new Promise((resolve) => setImmediate(resolve));
}

describe("HTTP request-duration histogram (PEN-5136)", () => {
  beforeEach(() => {
    __resetMetricsForTest();
  });
  afterEach(() => {
    __resetMetricsForTest();
  });

  describe("the bucket ladder answers the question the metric exists for", () => {
    /**
     * The reason this series exists is that a route crossing the inherited 30s
     * `statement_timeout` was only observable as a 503. `le="30"` is what makes
     * "rate at which this route crosses the bound" a direct read, so it is
     * pinned as a literal rather than left to a default exponential ladder that
     * happens to bracket it.
     */
    it("has the inherited 30s statement_timeout as an exact bucket edge", () => {
      expect(HTTP_REQUEST_DURATION_BUCKETS_SECONDS).toContain(30);
    });

    /** PEN-3596's regression walked 0.8s -> 5s -> 25s. An edge at 20 is what
     * separates the second and third of those from each other and from the
     * bound, i.e. what would have made the walk visible before it 503'd. */
    it("brackets the pre-timeout warning regime below the bound", () => {
      expect(HTTP_REQUEST_DURATION_BUCKETS_SECONDS).toContain(20);
      expect(HTTP_REQUEST_DURATION_BUCKETS_SECONDS).toContain(5);
      expect(HTTP_REQUEST_DURATION_BUCKETS_SECONDS).toContain(1);
    });

    /** An abandoned request can outlive the statement timeout, so the ladder
     * must not top out at the bound itself. */
    it("extends past the bound for the abandoned-request regime", () => {
      const edges = [...HTTP_REQUEST_DURATION_BUCKETS_SECONDS];
      expect(Math.max(...edges)).toBeGreaterThan(30);
    });

    it("is strictly ascending, as Prometheus requires", () => {
      const edges = [...HTTP_REQUEST_DURATION_BUCKETS_SECONDS];
      for (let i = 1; i < edges.length; i += 1) {
        expect(edges[i]).toBeGreaterThan(edges[i - 1]!);
      }
    });

    it("stays a short explicit ladder rather than a default exponential one", () => {
      expect(HTTP_REQUEST_DURATION_BUCKETS_SECONDS.length).toBeLessThanOrEqual(14);
    });
  });

  describe("cardinality: route and method only", () => {
    /**
     * The design constraint on this row, recorded at the availability-gate
     * probe metric: a histogram multiplies every label combination by the
     * bucket count. The parent counter's route x method x status is affordable
     * as a counter and is not affordable as a histogram, so `status` is
     * dropped here -- and a 200 and a 503 on one route/method must therefore
     * share one series.
     */
    it("does not carry a status label, so success and failure share a series", async () => {
      recordHttpRequest({
        route: "/api/companies/:companyId/issues",
        method: "GET",
        status: 200,
        emptyList: false,
        durationSeconds: 0.2,
      });
      recordHttpRequest({
        route: "/api/companies/:companyId/issues",
        method: "GET",
        status: 503,
        emptyList: false,
        durationSeconds: 31,
      });

      const values = await seriesFor(HTTP_REQUEST_DURATION_METRIC);
      for (const series of values) {
        expect(series.labels).not.toHaveProperty("status");
      }
      expect(
        await observationCount({ route: "/api/companies/:companyId/issues", method: "GET" }),
      ).toBe(2);

      // The parent counter keeps the finer breakdown it can afford.
      const counterValues = await seriesFor(HTTP_REQUESTS_METRIC);
      expect(counterValues.map((s) => String(s.labels.status)).sort()).toEqual(["200", "503"]);
    });

    it("keeps method, so a GET and a PATCH on one template stay separable", async () => {
      const app = buildApp();
      await call(app, "get", "/api/companies/c1/issues", 200);
      await call(app, "patch", "/api/companies/c1/issues", 200);

      expect(
        await observationCount({ route: "/api/companies/:companyId/issues", method: "GET" }),
      ).toBe(1);
      expect(
        await observationCount({ route: "/api/companies/:companyId/issues", method: "PATCH" }),
      ).toBe(1);
    });

    it("does not mint a series per path parameter", async () => {
      const app = buildApp();
      for (const id of ["c1", "c2", "c3", "c4"]) {
        await call(app, "get", `/api/companies/${id}/issues`, 200);
      }

      const counts = (await seriesFor(HTTP_REQUEST_DURATION_METRIC)).filter(
        (s) => s.metricName === `${HTTP_REQUEST_DURATION_METRIC}_count`,
      );
      expect(counts).toHaveLength(1);
      expect(counts[0]?.value).toBe(4);
    });

    /** Nothing is zero-initialized, so an unexercised route costs no series at
     * all -- which is what keeps the live cardinality the exercised pair count
     * rather than the ~300 declared templates times the ladder. */
    it("mints no series for a route that served no traffic", async () => {
      await call(buildApp(), "get", "/api/companies/c1/issues", 200);

      expect(
        await observationCount({ route: "/api/companies/:companyId/throws", method: "GET" }),
      ).toBe(0);
    });
  });

  describe("wiring through the middleware", () => {
    it("observes a served response on the full mounted route template", async () => {
      await call(buildApp(), "get", "/api/companies/c1/issues", 200);

      expect(
        await observationCount({ route: "/api/companies/:companyId/issues", method: "GET" }),
      ).toBe(1);
    });

    /**
     * The same label-capture problem the parent counter documents: Express
     * restores `req.baseUrl` as an error unwinds, so a throwing route would
     * otherwise report a prefix-less label and split its own latency away from
     * its success latency.
     */
    it("keeps a thrown route on the same label as a successful one", async () => {
      await call(buildApp(), "get", "/api/companies/c1/throws", 503);

      expect(
        await observationCount({ route: "/api/companies/:companyId/throws", method: "GET" }),
      ).toBe(1);
      expect(await observationCount({ route: "/companies/:companyId/throws" })).toBe(0);
    });

    it("observes unmatched requests too", async () => {
      await call(buildApp(), "get", "/api/nope", 404);

      expect(await observationCount({ route: HTTP_ROUTE_UNMATCHED, method: "GET" })).toBe(1);
    });

    /** A real elapsed time, not a placeholder: non-negative, and small enough
     * that a wall-clock bug (e.g. observing an epoch timestamp) would fail. */
    it("records a plausible elapsed duration rather than a constant", async () => {
      await call(buildApp(), "get", "/api/companies/c1/issues", 200);

      const sum = await observationSum({
        route: "/api/companies/:companyId/issues",
        method: "GET",
      });
      expect(sum).toBeGreaterThanOrEqual(0);
      expect(sum).toBeLessThan(30);
    });

    it("exposes the series in the rendered scrape output", async () => {
      await call(buildApp(), "get", "/api/companies/c1/issues", 200);

      const { body } = await renderMetrics();
      expect(body).toContain(`${HTTP_REQUEST_DURATION_METRIC}_bucket`);
      expect(body).toContain('le="30"');
      expect(body).toContain(`# TYPE ${HTTP_REQUEST_DURATION_METRIC} histogram`);
    });
  });

  describe("a clock fault cannot poison the sum", () => {
    /**
     * `_sum` is monotonic and cannot be repaired without a process restart, so
     * one `NaN` observation would make the mean latency for that route
     * permanently unreadable. Dropping the value is strictly better than
     * recording it, and the counters must be unaffected either way.
     */
    it.each([
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["negative", -1],
    ])("drops a %s duration without observing it", async (_name, durationSeconds) => {
      const result = recordHttpRequest({
        route: "/api/companies/:companyId/issues",
        method: "GET",
        status: 200,
        emptyList: false,
        durationSeconds,
      });

      expect(result.durationSeconds).toBeNull();
      expect(
        await observationCount({ route: "/api/companies/:companyId/issues", method: "GET" }),
      ).toBe(0);
      const sum = await observationSum({
        route: "/api/companies/:companyId/issues",
        method: "GET",
      });
      expect(Number.isFinite(sum)).toBe(true);
    });

    it("still records the status counter when the duration is unusable", async () => {
      recordHttpRequest({
        route: "/api/companies/:companyId/issues",
        method: "GET",
        status: 200,
        emptyList: false,
        durationSeconds: Number.NaN,
      });

      const counterValues = await seriesFor(HTTP_REQUESTS_METRIC);
      expect(counterValues.find((s) => String(s.labels.status) === "200")?.value).toBe(1);
    });

    /** An omitted duration is the documented optional case, not an error. */
    it("records the counters when no duration is supplied at all", async () => {
      const result = recordHttpRequest({
        route: "/api/companies/:companyId/issues",
        method: "GET",
        status: 200,
        emptyList: false,
      });

      expect(result.durationSeconds).toBeNull();
      expect(
        await observationCount({ route: "/api/companies/:companyId/issues", method: "GET" }),
      ).toBe(0);
    });

    it("observes a zero duration rather than treating it as absent", async () => {
      const result = recordHttpRequest({
        route: "/api/companies/:companyId/issues",
        method: "GET",
        status: 200,
        emptyList: false,
        durationSeconds: 0,
      });

      expect(result.durationSeconds).toBe(0);
      expect(
        await observationCount({ route: "/api/companies/:companyId/issues", method: "GET" }),
      ).toBe(1);
      expect(
        await bucketAt("0.025", { route: "/api/companies/:companyId/issues", method: "GET" }),
      ).toBe(1);
    });
  });

  describe("the bound is readable as a rate", () => {
    /**
     * The query this series is for:
     *   rate(_count) - rate(_bucket{le="30"})
     * is the rate at which a route exceeds the statement timeout. That only
     * works if an over-bound observation is excluded from `le="30"` and
     * included in `_count`, so pin exactly that.
     */
    it("excludes an over-bound observation from le=30 but counts it", async () => {
      const labels = { route: "/api/companies/:companyId/issues", method: "GET" };
      recordHttpRequest({ ...labels, status: 200, emptyList: false, durationSeconds: 0.3 });
      recordHttpRequest({ ...labels, status: 503, emptyList: false, durationSeconds: 31.5 });

      expect(await observationCount(labels)).toBe(2);
      expect(await bucketAt("30", labels)).toBe(1);
      expect(await bucketAt("60", labels)).toBe(2);
    });
  });
});
