import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { httpMetricsMiddleware } from "../middleware/http-metrics.js";
import {
  HTTP_EMPTY_LIST_RESPONSES_METRIC,
  HTTP_REQUESTS_METRIC,
  HTTP_ROUTE_LABEL_CAP,
  HTTP_ROUTE_OVERFLOW,
  HTTP_ROUTE_UNMATCHED,
  __resetMetricsForTest,
  getMetricsRegistry,
  normalizeHttpMethod,
  normalizeHttpRoute,
  normalizeHttpStatus,
  renderMetrics,
} from "../services/metrics.js";

/**
 * PEN-3702. Before these counters existed, `paperclip_auth_request_total` was
 * the only request counter in the process, so "did this route return an empty
 * success instead of an error?" could not be answered live or retrospectively
 * by anyone. These tests pin the two properties that make it answerable: the
 * route label is stable across every response path, and an empty list is
 * distinguishable from an error at the moment it is served.
 */

type Series = { value: number; labels: Record<string, string | number> };

async function seriesFor(metricName: string): Promise<Series[]> {
  const metric = getMetricsRegistry().getSingleMetric(metricName);
  if (!metric) return [];
  const snapshot = (await metric.get()) as { values: Series[] };
  return snapshot.values;
}

/**
 * Sum of series matching every supplied label. Returns 0 for "no such series",
 * so asserting 0 covers both "counted zero" and "never minted" -- which is the
 * claim these tests actually want to make.
 */
async function countOf(metricName: string, labels: Record<string, string>): Promise<number> {
  const values = await seriesFor(metricName);
  return values
    .filter((s) => Object.entries(labels).every(([k, v]) => String(s.labels[k]) === v))
    .reduce((sum, s) => sum + s.value, 0);
}

const requests = (labels: Record<string, string>) => countOf(HTTP_REQUESTS_METRIC, labels);
const empties = (labels: Record<string, string>) => countOf(HTTP_EMPTY_LIST_RESPONSES_METRIC, labels);

/**
 * Issue a request and then yield the event loop before asserting.
 *
 * The counters are written from `res.on("finish")`, which fires when the
 * server hands the last chunk to the socket -- ordinarily before the client
 * sees the response, but nothing guarantees that ordering. Yielding once
 * removes the race rather than relying on it.
 */
async function call(
  app: express.Express,
  method: "get" | "post",
  path: string,
  expectedStatus: number,
) {
  const res = await request(app)[method](path).expect(expectedStatus);
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

/**
 * An app shaped like the real one: an `/api` mount containing both a
 * root-mounted router (the dominant idiom) and a prefix-mounted router (the
 * `companies.ts` exception), plus a terminal error handler.
 */
function buildApp() {
  const app = express();
  app.use(httpMetricsMiddleware());

  const api = express.Router();

  const rootMounted = express.Router();
  rootMounted.get("/companies/:companyId/approvals", (_req, res) => {
    res.json([]);
  });
  rootMounted.get("/companies/:companyId/issues", (_req, res) => {
    res.json([{ id: "i1" }, { id: "i2" }]);
  });
  rootMounted.get("/companies/:companyId/throws", () => {
    throw Object.assign(new Error("pool exhausted"), { status: 503 });
  });
  rootMounted.get("/companies/:companyId/refuse", (_req, res) => {
    res.status(403).json({ error: "outside this actor's authorization boundary" });
  });
  rootMounted.get("/companies/:companyId/plain", (_req, res) => {
    res.status(200).send("ok");
  });
  rootMounted.get("/companies/:companyId/count", (_req, res) => {
    res.json({ count: 0 });
  });
  rootMounted.get("/plugins/:pluginId/api/*splat", (_req, res) => {
    res.json({ ok: true });
  });
  api.use(rootMounted);

  const prefixMounted = express.Router();
  prefixMounted.get("/:companyId/members", (_req, res) => {
    res.json([]);
  });
  api.use("/companies", prefixMounted);

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

describe("per-route HTTP status instrumentation (PEN-3702)", () => {
  beforeEach(() => {
    __resetMetricsForTest();
  });
  afterEach(() => {
    __resetMetricsForTest();
  });

  it("labels a successful response with the full mounted route template", async () => {
    await call(buildApp(), "get", "/api/companies/c1/issues", 200);

    expect(
      await requests({
        route: "/api/companies/:companyId/issues",
        method: "GET",
        status: "200",
      }),
    ).toBe(1);
  });

  it("does not mint a series per path parameter", async () => {
    const app = buildApp();
    for (const id of ["c1", "c2", "c3", "c4"]) {
      await call(app, "get", `/api/companies/${id}/issues`, 200);
    }

    const values = await seriesFor(HTTP_REQUESTS_METRIC);
    expect(values).toHaveLength(1);
    expect(values[0]?.value).toBe(4);
    expect(values[0]?.labels.route).toBe("/api/companies/:companyId/issues");
  });

  /**
   * The regression the route accessor exists to prevent. Express restores
   * `req.baseUrl` as an error unwinds to the app-level handler, so reading
   * `req.baseUrl + req.route.path` at response-finish time labels a thrown
   * 503 as "/companies/:companyId/throws" while the sibling 200 is labelled
   * "/api/companies/:companyId/issues". Splitting a route's error series away
   * from its success series would defeat the counter's purpose.
   */
  it("keeps the mount prefix on a route that throws, matching the success path", async () => {
    await call(buildApp(), "get", "/api/companies/c1/throws", 503);

    expect(
      await requests({
        route: "/api/companies/:companyId/throws",
        method: "GET",
        status: "503",
      }),
    ).toBe(1);
    // The prefix-stripped label is what a finish-time read would have produced.
    expect(await requests({ route: "/companies/:companyId/throws" })).toBe(0);
  });

  it("labels an inline refusal with the same route shape as a success", async () => {
    await call(buildApp(), "get", "/api/companies/c1/refuse", 403);

    expect(
      await requests({
        route: "/api/companies/:companyId/refuse",
        method: "GET",
        status: "403",
      }),
    ).toBe(1);
  });

  it("composes the prefix for a router mounted under a path", async () => {
    await call(buildApp(), "get", "/api/companies/c1/members", 200);

    expect(await requests({ route: "/api/companies/:companyId/members", status: "200" })).toBe(1);
  });

  it("collapses unmatched requests onto a single series", async () => {
    const app = buildApp();
    for (const path of ["/api/nope/a", "/api/nope/b", "/totally/elsewhere"]) {
      await call(app, "get", path, 404);
    }

    expect(await requests({ route: HTTP_ROUTE_UNMATCHED, status: "404" })).toBe(3);
  });

  it("labels a splat route by its template", async () => {
    await call(buildApp(), "get", "/api/plugins/p1/api/deep/nested/path", 200);

    expect(await requests({ route: "/api/plugins/:pluginId/api/*splat" })).toBe(1);
  });

  describe("empty-list discrimination", () => {
    /**
     * The question that could not be answered: four list-route calls returned
     * zero rows, and nothing recorded whether they were empty 200s or 5xxs
     * rendered as 0 by a row-counting caller. These two cases are that
     * distinction.
     */
    it("counts an empty 200 in both families", async () => {
      await call(buildApp(), "get", "/api/companies/c1/approvals", 200);

      const labels = {
        route: "/api/companies/:companyId/approvals",
        method: "GET",
        status: "200",
      };
      expect(await requests(labels)).toBe(1);
      expect(await empties(labels)).toBe(1);
    });

    it("counts a 503 only as a request, never as an empty list", async () => {
      await call(buildApp(), "get", "/api/companies/c1/throws", 503);

      const labels = { route: "/api/companies/:companyId/throws", method: "GET" };
      expect(await requests({ ...labels, status: "503" })).toBe(1);
      expect(await empties(labels)).toBe(0);
    });

    it("does not count a non-empty list as empty", async () => {
      await call(buildApp(), "get", "/api/companies/c1/issues", 200);

      const labels = { route: "/api/companies/:companyId/issues", method: "GET" };
      expect(await requests({ ...labels, status: "200" })).toBe(1);
      expect(await empties(labels)).toBe(0);
    });

    it("does not infer emptiness from a wrapped body", async () => {
      await call(buildApp(), "get", "/api/companies/c1/count", 200);

      const labels = { route: "/api/companies/:companyId/count", method: "GET" };
      expect(await requests({ ...labels, status: "200" })).toBe(1);
      // `{ count: 0 }` is a different claim than "zero rows were serialized".
      expect(await empties(labels)).toBe(0);
    });

    it("counts a non-JSON response as a request but not as an empty list", async () => {
      await call(buildApp(), "get", "/api/companies/c1/plain", 200);

      const labels = { route: "/api/companies/:companyId/plain", method: "GET" };
      expect(await requests({ ...labels, status: "200" })).toBe(1);
      expect(await empties(labels)).toBe(0);
    });

    it("keeps the empty counter a strict subset of the request counter", async () => {
      const app = buildApp();
      await call(app, "get", "/api/companies/c1/approvals", 200);
      await call(app, "get", "/api/companies/c1/issues", 200);
      await call(app, "get", "/api/companies/c1/throws", 503);

      const total = (await seriesFor(HTTP_REQUESTS_METRIC)).reduce((s, v) => s + v.value, 0);
      const empty = (await seriesFor(HTTP_EMPTY_LIST_RESPONSES_METRIC)).reduce(
        (s, v) => s + v.value,
        0,
      );
      expect(total).toBe(3);
      expect(empty).toBe(1);
      expect(empty).toBeLessThanOrEqual(total);
    });
  });

  it("separates methods on one route", async () => {
    const app = express();
    app.use(httpMetricsMiddleware());
    app.get("/items", (_req, res) => {
      res.json([]);
    });
    app.post("/items", (_req, res) => {
      res.status(201).json({ id: "x" });
    });

    await call(app, "get", "/items", 200);
    await call(app, "post", "/items", 201);

    expect(await requests({ route: "/items", method: "GET", status: "200" })).toBe(1);
    expect(await requests({ route: "/items", method: "POST", status: "201" })).toBe(1);
  });

  it("counts once even if the middleware is mounted twice", async () => {
    const app = express();
    app.use(httpMetricsMiddleware());
    app.use(httpMetricsMiddleware());
    app.get("/items", (_req, res) => {
      res.json([]);
    });

    await call(app, "get", "/items", 200);

    expect(await requests({ route: "/items", status: "200" })).toBe(1);
    expect(await empties({ route: "/items", status: "200" })).toBe(1);
  });

  it("leaves the response body untouched", async () => {
    const res = await call(buildApp(), "get", "/api/companies/c1/issues", 200);
    expect(res.body).toEqual([{ id: "i1" }, { id: "i2" }]);

    const empty = await call(buildApp(), "get", "/api/companies/c1/approvals", 200);
    expect(empty.body).toEqual([]);
  });

  /**
   * A request the client abandons (or the ingress times out) never emits
   * `finish`, so a finish-only listener drops it from the counter entirely --
   * in exactly the hung-request regime a pool excursion produces.
   */
  describe("aborted and completed responses", () => {
    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    const total = async () =>
      (await seriesFor(HTTP_REQUESTS_METRIC)).reduce((s, v) => s + v.value, 0);

    it('counts a client-aborted request exactly once, on the "0" status sentinel', async () => {
      const arrived = deferred();
      const closed = deferred();
      const app = express();
      app.use(httpMetricsMiddleware());
      app.get("/hangs", (_req, res) => {
        // Registered after the middleware's listeners, so it fires after them.
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
          // The abort below surfaces client-side as a socket hang up.
        });
        await arrived.promise;
        clientReq.destroy();
        await closed.promise;
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }

      expect(await requests({ route: "/hangs", method: "GET", status: "0" })).toBe(1);
      // Node's default statusCode is 200; an abort must not masquerade as one.
      expect(await requests({ status: "200" })).toBe(0);
      expect(await total()).toBe(1);
    });

    it("counts a completed response once even though close also fires", async () => {
      const closed = deferred();
      const app = express();
      app.use(httpMetricsMiddleware());
      app.get("/items", (_req, res) => {
        res.once("close", closed.resolve);
        res.json([]);
      });

      await call(app, "get", "/items", 200);
      await closed.promise;

      expect(await requests({ route: "/items", method: "GET", status: "200" })).toBe(1);
      expect(await empties({ route: "/items", status: "200" })).toBe(1);
      expect(await total()).toBe(1);
    });
  });

  /**
   * Registering a counter and exposing it are different claims. The scrape is
   * the only thing Prometheus ever sees, so assert the series actually reach
   * the exposition rather than stopping at the registry.
   */
  it("exposes both families on the scrape path", async () => {
    const app = buildApp();
    await call(app, "get", "/api/companies/c1/approvals", 200);
    await call(app, "get", "/api/companies/c1/throws", 503);

    const { body } = await renderMetrics();

    expect(body).toContain(`# TYPE ${HTTP_REQUESTS_METRIC} counter`);
    expect(body).toContain(`# TYPE ${HTTP_EMPTY_LIST_RESPONSES_METRIC} counter`);
    expect(body).toContain(
      `${HTTP_REQUESTS_METRIC}{route="/api/companies/:companyId/approvals",method="GET",status="200"} 1`,
    );
    expect(body).toContain(
      `${HTTP_EMPTY_LIST_RESPONSES_METRIC}{route="/api/companies/:companyId/approvals",method="GET",status="200"} 1`,
    );
    // The 503 is a request but not an empty list -- the distinction the row exists for.
    expect(body).toContain(
      `${HTTP_REQUESTS_METRIC}{route="/api/companies/:companyId/throws",method="GET",status="503"} 1`,
    );
    expect(body).not.toContain(
      `${HTTP_EMPTY_LIST_RESPONSES_METRIC}{route="/api/companies/:companyId/throws"`,
    );
  });

  /**
   * Label bounding is asserted directly rather than through 500+ HTTP round
   * trips. Route labels come from a finite set of declared Express templates,
   * so the cap should never fire in production; it exists so that a future
   * dynamically-registered route cannot turn this counter into a cardinality
   * incident, and a non-zero overflow series is the signal that one tried.
   */
  describe("label bounding", () => {
    it("collapses routes past the cap onto an overflow series", () => {
      for (let i = 0; i < HTTP_ROUTE_LABEL_CAP; i += 1) {
        expect(normalizeHttpRoute(`/r${i}`)).toBe(`/r${i}`);
      }
      expect(normalizeHttpRoute("/one-too-many")).toBe(HTTP_ROUTE_OVERFLOW);
      // An already-seen route keeps its own label after the cap is reached.
      expect(normalizeHttpRoute("/r0")).toBe("/r0");
    });

    it("maps a missing route to the unmatched sentinel", () => {
      expect(normalizeHttpRoute(null)).toBe(HTTP_ROUTE_UNMATCHED);
      expect(normalizeHttpRoute(undefined)).toBe(HTTP_ROUTE_UNMATCHED);
      expect(normalizeHttpRoute("   ")).toBe(HTTP_ROUTE_UNMATCHED);
    });

    it("truncates an over-long route label", () => {
      expect(normalizeHttpRoute(`/${"x".repeat(500)}`).length).toBeLessThanOrEqual(200);
    });

    it("bounds the method label", () => {
      expect(normalizeHttpMethod("get")).toBe("GET");
      expect(normalizeHttpMethod("PATCH")).toBe("PATCH");
      expect(normalizeHttpMethod("PROPFIND")).toBe("OTHER");
      expect(normalizeHttpMethod(null)).toBe("OTHER");
    });

    it("bounds the status label to real HTTP codes", () => {
      expect(normalizeHttpStatus(200)).toBe("200");
      expect(normalizeHttpStatus(503)).toBe("503");
      expect(normalizeHttpStatus(0)).toBe("0");
      expect(normalizeHttpStatus(99)).toBe("0");
      expect(normalizeHttpStatus(600)).toBe("0");
      expect(normalizeHttpStatus(null)).toBe("0");
    });
  });
});
