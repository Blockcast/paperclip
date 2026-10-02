import type { NextFunction, Request, RequestHandler, Response } from "express";

import { recordHttpRequest } from "../services/metrics.js";

/**
 * Per-route HTTP status instrumentation (PEN-3702).
 *
 * Records every served response into `paperclip_http_requests_total`, and the
 * subset whose body was a bare empty array into
 * `paperclip_http_empty_list_responses_total`.
 *
 * ## Why this exists
 *
 * Before this, `paperclip_auth_request_total` was the only request counter in
 * the process and it is scoped to Better Auth operations, so no query could
 * characterise a fault on an ordinary API route. When four list-route calls
 * came back with zero rows during a database-pool excursion
 * (2026-09-24T04:05-04:11Z), it was never provable whether they were empty
 * `200`s or `5xx`s that the caller's row-counting script rendered as `0` --
 * not by the reporter, not by the CTO, not by a human with full cluster
 * access. Nothing retained per-request status, so the episode could only ever
 * be a correlation. That distinction is unrecoverable after the fact, which is
 * why it has to be recorded at the moment the response is served.
 *
 * The access log is not a substitute: it carries the raw URL
 * (`GET /heartbeat-runs/<uuid> 200`) rather than the route template, so it
 * cannot be aggregated by route, and `shouldSilenceHttpSuccessLog` drops
 * successful requests on the hottest API paths entirely.
 *
 * ## Mount position
 *
 * Mount immediately after `httpLogger`, which places it after the `/metrics`
 * and `/healthz` routes. That is deliberate and matches the logger's own
 * rationale: a scrape should not increment the counters it is scraping.
 *
 * ## Why the route label is captured through an accessor
 *
 * The obvious implementation -- read `req.baseUrl + req.route.path` when the
 * response finishes -- is wrong on exactly the path that matters most.
 * Express restores `req.baseUrl` as an error unwinds back to the app-level
 * error handler, so a route that *throws* reports a different label than the
 * same route when it succeeds. Measured against Express 5.2.1:
 *
 *     GET /api/companies/:companyId/approvals  ->  "/api/companies/:companyId/approvals"
 *     GET /api/companies/:companyId/throws     ->  "/companies/:companyId/throws"   (prefix lost)
 *
 * Splitting a route's 5xx series away from its 2xx series would defeat the
 * purpose of the counter. Dropping the prefix instead is not an option
 * either: routers mounted under a prefix (`api.use("/companies", ...)`)
 * declare paths like `/:companyId/members`, which is ambiguous on its own.
 *
 * So the label is captured at the instant Express assigns `req.route`, while
 * `req.baseUrl` is still the mounted prefix. That is the one moment both
 * halves are simultaneously correct, and it holds on every path -- success,
 * inline refusal, and thrown error alike. The accessor is transparent
 * (Express reads back exactly what it wrote) and fail-safe: if installing it
 * throws, the finish-time read is used as a fallback.
 *
 * ## Reading the `<unmatched>` bucket
 *
 * Anything Express did not dispatch to a declared route lands there, which
 * covers both genuine 404s and responses served by non-route middleware --
 * static assets and the SPA catch-all, whose path is a RegExp and so has no
 * stable template. The `status` label separates them: `<unmatched>` with a
 * 2xx/304 is asset traffic, with a 404 it is a real miss.
 */

/** Marks a response as already instrumented, so a double mount cannot
 * double-count. */
const INSTRUMENTED = Symbol.for("paperclip.httpMetricsInstrumented");

type InstrumentableResponse = Response & { [INSTRUMENTED]?: boolean };

/** Compose the mounted route template from the prefix and the declared path.
 * `path` is only usable when it is a string -- a route declared with a RegExp
 * (the SPA catch-all) has no stable template and is left unmatched. */
function composeRouteLabel(baseUrl: string, path: unknown): string | null {
  if (typeof path !== "string") return null;
  // A router mounted at a prefix and declaring "/" would otherwise render as
  // "/api/" rather than "/api".
  if (path === "/" && baseUrl) return baseUrl;
  return `${baseUrl}${path}`;
}

/** True only for a bare empty array -- the zero-row signal. A wrapped body
 * such as `{ count: 0 }` or `{ issues: [] }` is a different claim and is
 * deliberately not inferred. */
function isEmptyListBody(body: unknown): boolean {
  return Array.isArray(body) && body.length === 0;
}

export function httpMetricsMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const instrumentable = res as InstrumentableResponse;
    if (instrumentable[INSTRUMENTED]) {
      next();
      return;
    }
    instrumentable[INSTRUMENTED] = true;

    let capturedRoute: string | null = null;
    let emptyList = false;

    // Capture the route template while `req.baseUrl` still holds the mounted
    // prefix. See the block comment above for why finish-time is too late.
    try {
      let routeValue: unknown;
      Object.defineProperty(req, "route", {
        configurable: true,
        enumerable: true,
        get() {
          return routeValue;
        },
        set(value: unknown) {
          routeValue = value;
          const label = composeRouteLabel(
            req.baseUrl,
            (value as { path?: unknown } | null | undefined)?.path,
          );
          if (label) capturedRoute = label;
        },
      });
    } catch {
      // Fall back to the finish-time read below. Losing the prefix on thrown
      // errors is worse than nothing, but it is strictly better than losing
      // the whole counter.
    }

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      try {
        emptyList = isEmptyListBody(body);
      } catch {
        // Never let instrumentation interfere with serving the response.
      }
      return originalJson(body);
    }) as typeof res.json;

    // `finish` alone never fires for a request the client abandoned or the
    // ingress timed out -- the hung-request regime a pool excursion produces.
    // `close` fires on both normal completion and premature termination, so
    // listen on both and latch to record exactly once.
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      try {
        const fallbackRoute = capturedRoute
          ? null
          : composeRouteLabel(req.baseUrl, req.route?.path);
        recordHttpRequest({
          route: capturedRoute ?? fallbackRoute,
          method: req.method,
          // An aborted response still holds Node's default 200; report it on
          // the "0" sentinel instead of as a success it never was.
          status: res.writableFinished ? res.statusCode : null,
          emptyList,
        });
      } catch {
        // A metrics failure must never surface as a request failure. The
        // response has already been sent (or abandoned) by this point.
      }
    };
    res.once("finish", record);
    res.once("close", record);

    next();
  };
}
