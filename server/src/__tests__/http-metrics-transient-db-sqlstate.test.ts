import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { STATEMENT_TIMEOUT_SQLSTATE, TRANSIENT_DB_SQLSTATES } from "../lib/db-retry.js";
import { errorHandler } from "../middleware/error-handler.js";
import { httpMetricsMiddleware, noteTransientDbResponse } from "../middleware/http-metrics.js";
import {
  HTTP_REQUESTS_METRIC,
  HTTP_TRANSIENT_DB_RESPONSES_METRIC,
  HTTP_TRANSIENT_DB_SQLSTATE_OTHER,
  __resetMetricsForTest,
  getMetricsRegistry,
  normalizeHttpTransientDbCode,
  normalizeHttpTransientDbSqlstate,
  recordHttpRequest,
} from "../services/metrics.js";

/**
 * PEN-3596. `paperclip_http_requests_total` has no SQLSTATE dimension, so a
 * `503` on a route is only a PROXY for a statement timeout -- the three
 * contention sqlstates land in the same status bucket. That left the row's
 * "no statement timeouts over a representative window" condition readable
 * only as an upper bound (measured 2026-10-29: 79 `503`s/24h on the
 * issues-list route, with no way to say how many were `57014`).
 *
 * These tests pin the properties that make it a measurement: `57014` is
 * separable from contention, the subset carries the SAME route AND status
 * labels as its parent counter, and the labels stay bounded.
 */

type Series = { value: number; labels: Record<string, string | number> };

async function countOf(metricName: string, labels: Record<string, string>): Promise<number> {
  const metric = getMetricsRegistry().getSingleMetric(metricName);
  if (!metric) return 0;
  const snapshot = (await metric.get()) as { values: Series[] };
  return snapshot.values
    .filter((s) => Object.entries(labels).every(([k, v]) => String(s.labels[k]) === v))
    .reduce((sum, s) => sum + s.value, 0);
}

const refusals = (labels: Record<string, string>) =>
  countOf(HTTP_TRANSIENT_DB_RESPONSES_METRIC, labels);
const requests = (labels: Record<string, string>) => countOf(HTTP_REQUESTS_METRIC, labels);

/** A pg driver error as `findPgError` recognizes it. */
function pgError(code: string) {
  return Object.assign(new Error(`db failed (${code})`), { code });
}

/**
 * Shaped like the real app: the metrics middleware outermost, a router mounted
 * under `/api`, and the real `errorHandler` terminal. The prefix mount matters
 * -- it is what makes the route-label claim below non-trivial.
 */
function buildApp() {
  const app = express();
  app.use(httpMetricsMiddleware());

  const api = express.Router();
  const router = express.Router();
  for (const code of [...TRANSIENT_DB_SQLSTATES]) {
    router.get(`/companies/:companyId/fail-${code}`, () => {
      throw pgError(code);
    });
  }
  router.get("/companies/:companyId/fail-unknown", () => {
    throw pgError("23505");
  });
  router.get("/companies/:companyId/issues", (_req, res) => {
    res.json([]);
  });
  api.use(router);
  app.use("/api", api);
  app.use(errorHandler);
  return app;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function call(app: express.Express, path: string, expectedStatus: number) {
  const res = await request(app).get(path).expect(expectedStatus);
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

describe("transient-database 503 sqlstate instrumentation (PEN-3596)", () => {
  let app: express.Express;

  beforeEach(() => {
    __resetMetricsForTest();
    app = buildApp();
  });

  it("separates a statement timeout from lock contention on the same route and status", async () => {
    await call(app, `/api/companies/c1/fail-${STATEMENT_TIMEOUT_SQLSTATE}`, 503);
    await call(app, "/api/companies/c1/fail-40P01", 503);
    await call(app, "/api/companies/c1/fail-55P03", 503);

    // The whole defect: all three are 503s, and before this counter the only
    // available question was "how many 503s", whose answer is 3 for a route
    // that timed out once.
    expect(await refusals({ sqlstate: STATEMENT_TIMEOUT_SQLSTATE })).toBe(1);
    expect(await refusals({ sqlstate: "40P01" })).toBe(1);
    expect(await refusals({ sqlstate: "55P03" })).toBe(1);

    // And the API-boundary classification splits the same way, so either
    // dimension answers it.
    expect(await refusals({ code: "statement_timeout" })).toBe(1);
    expect(await refusals({ code: "transient_db_conflict" })).toBe(2);
  });

  it("labels the subset with the same route template the parent counter used", async () => {
    // This is the reason the increment is threaded through `recordHttpRequest`
    // rather than done in the error handler. Express restores `req.baseUrl` as
    // an error unwinds, so an error handler building its own label would emit
    // "/companies/:companyId/fail-57014" while the parent counter emitted
    // "/api/companies/:companyId/fail-57014" -- and `subset/total` would then
    // divide two different routes.
    const route = `/api/companies/:companyId/fail-${STATEMENT_TIMEOUT_SQLSTATE}`;
    await call(app, `/api/companies/c1/fail-${STATEMENT_TIMEOUT_SQLSTATE}`, 503);

    expect(await requests({ route, status: "503" })).toBe(1);
    // Same route AND same status, so the ratio is taken between two series
    // that describe the same population.
    expect(await refusals({ route, status: "503", sqlstate: STATEMENT_TIMEOUT_SQLSTATE })).toBe(1);
    // No series under the prefix-stripped label on either counter.
    expect(await refusals({ route: `/companies/:companyId/fail-${STATEMENT_TIMEOUT_SQLSTATE}` })).toBe(0);
  });

  it("puts an abandoned refusal on the same \"0\" status as the parent, not on 503", async () => {
    // The response whose socket closes before the body flushes. `recordHttpRequest`
    // is called directly because the middleware's only input here is
    // `res.writableFinished === false`, which is exactly the `status: null` below.
    //
    // Without the shared `status` label the subset would increment while the
    // parent recorded "0", and `subset / parent{status="503"}` could exceed 1 --
    // a rate above 100%, on the one counter PEN-3596 Done-when #2 is read from.
    const route = "/api/companies/:companyId/issues";
    recordHttpRequest({
      route,
      method: "GET",
      status: null,
      emptyList: false,
      transientDb: { code: "statement_timeout", sqlstate: STATEMENT_TIMEOUT_SQLSTATE },
    });

    expect(await requests({ route, status: "0" })).toBe(1);
    expect(await requests({ route, status: "503" })).toBe(0);
    expect(await refusals({ route, status: "0" })).toBe(1);
    expect(await refusals({ route, status: "503" })).toBe(0);
  });

  it("carries the tag through the middleware on the close path, not only on finish", async () => {
    // Companion to the test above, and the one that covers the MIDDLEWARE. That
    // one calls `recordHttpRequest` directly, which is the right shape for the
    // label question but bypasses the seam this PR invented: the error handler
    // tags the response, and `record()` reads the tag at finish-OR-close.
    //
    // Verified by mutation: gating the read on `res.writableFinished` (so an
    // abandoned refusal silently loses its tag) leaves the direct-call test
    // green and turns only this one red. Without this, a regression that drops
    // abandoned refusals entirely would ship unnoticed -- and those are exactly
    // the 57014s worth seeing, since a statement that ran past the timeout is
    // the one whose client is most likely to have given up.
    const arrived = deferred();
    const closed = deferred();
    const hangApp = express();
    hangApp.use(httpMetricsMiddleware());
    hangApp.get("/refuses-then-hangs", (_req, res) => {
      noteTransientDbResponse(res, {
        code: "statement_timeout",
        sqlstate: STATEMENT_TIMEOUT_SQLSTATE,
      });
      // Registered after the middleware's listeners, so it fires after them.
      res.once("close", closed.resolve);
      arrived.resolve();
      // Never responds: the refusal whose client went away before the flush.
    });

    const server = http.createServer(hangApp);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const clientReq = http.get({ host: "127.0.0.1", port, path: "/refuses-then-hangs" });
      clientReq.on("error", () => {
        // The destroy below surfaces client-side as a socket hang up.
      });
      await arrived.promise;
      clientReq.destroy();
      await closed.promise;
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }

    const route = "/refuses-then-hangs";
    expect(await refusals({ route, status: "0" })).toBe(1);
    expect(await refusals({ route, status: "503" })).toBe(0);
    expect(await requests({ route, status: "0" })).toBe(1);
  });

  it("is a strict subset: it counts no response that was not a transient-db refusal", async () => {
    await call(app, "/api/companies/c1/issues", 200);
    await call(app, "/api/companies/c1/fail-unknown", 500);

    // A 200 and a non-transient 500 both increment the parent and neither
    // increments the subset, so an absent series means "never refused".
    expect(await requests({ route: "/api/companies/:companyId/issues" })).toBe(1);
    expect(await refusals({})).toBe(0);
  });

  it("bounds the sqlstate label to the retry classifier's own set", () => {
    // The allow-list IS `TRANSIENT_DB_SQLSTATES`, not a copy, so a sqlstate
    // added to the retry path cannot silently land in `other`.
    //
    // Note what this does NOT show: `other` is unreachable through the real
    // path, because `error-handler.ts` only tags a response when that same set
    // already matched. These calls reach the normalizer directly. The bucket is
    // a cardinality guard against a malformed driver `code`, not a drift
    // detector -- its absence in production is evidence of nothing.
    for (const code of TRANSIENT_DB_SQLSTATES) {
      expect(normalizeHttpTransientDbSqlstate(code)).toBe(code);
    }
    for (const bogus of ["23505", "", "   ", "x".repeat(500), null, undefined]) {
      expect(normalizeHttpTransientDbSqlstate(bogus)).toBe(HTTP_TRANSIENT_DB_SQLSTATE_OTHER);
    }
  });

  it("bounds the code label, defaulting to the error handler's own default branch", () => {
    expect(normalizeHttpTransientDbCode("statement_timeout")).toBe("statement_timeout");
    expect(normalizeHttpTransientDbCode("transient_db_conflict")).toBe("transient_db_conflict");
    for (const bogus of ["nonsense", "", null, undefined]) {
      expect(normalizeHttpTransientDbCode(bogus)).toBe("transient_db_conflict");
    }
  });
});
