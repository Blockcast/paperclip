import type pino from "pino";
import { pinoHttp } from "pino-http";
import { redactSensitive } from "./redact-sensitive.js";

const SILENCED_SUCCESS_METHODS = new Set(["GET", "HEAD"]);

const SILENCED_SUCCESS_API_PATHS = [
  /^\/api\/health(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/activity(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/dashboard(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/heartbeat-runs(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/issues(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/live-runs(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/sidebar-badges(?:\/|$)/,
  /^\/api\/heartbeat-runs\/[^/]+\/log(?:\/|$)/,
];

const SILENCED_SUCCESS_STATIC_PREFIXES = [
  "/@fs/",
  "/@id/",
  "/@react-refresh",
  "/@vite/",
  "/_plugins/",
  "/assets/",
  "/node_modules/",
  "/src/",
];

const SILENCED_SUCCESS_STATIC_PATHS = new Set([
  "/",
  "/index.html",
  "/favicon.ico",
  "/site.webmanifest",
  "/sw.js",
]);

function normalizePath(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return "/";
  const pathname = trimmed.split("?")[0]?.trim() ?? "/";
  return pathname.length > 0 ? pathname : "/";
}

export function shouldSilenceHttpSuccessLog(method: string | undefined, url: string | undefined, statusCode: number): boolean {
  if (statusCode >= 400) return false;
  if (statusCode === 304) return true;
  if (!method || !url) return false;
  if (!SILENCED_SUCCESS_METHODS.has(method.toUpperCase())) return false;

  const pathname = normalizePath(url);
  if (SILENCED_SUCCESS_STATIC_PATHS.has(pathname)) return true;
  if (SILENCED_SUCCESS_STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  return SILENCED_SUCCESS_API_PATHS.some((pattern) => pattern.test(pathname));
}

// Routes whose request body is third-party payload and must never be logged,
// redacted or otherwise (BLO-29716).
//
// `redactSensitive` is a denylist of key *names*. That works for our own
// routes, where somebody can write the credential-bearing names down in
// advance. It cannot work for plugin webhook ingress: the body is arbitrary
// JSON authored by an external sender. Slack's event envelope carries its
// verification token under the top-level key `token`, which is deliberately
// NOT on the denylist — see the "pagination cursors and CSRF tokens are not
// credentials" case in redact-sensitive.test.ts. Adding it there would either
// blank legitimate cursors everywhere or, if scoped, still leave the next
// plugin's differently-named credential exposed.
//
// So for these routes the set of safely loggable body fields is empty, and we
// log shape instead of content. Top-level key *names* are kept: they are the
// diagnostic that makes the line worth having ("did a `challenge` arrive?")
// and a name is not the credential the sender put in its value.
//
// The query string is sender-authored on these URLs too — this route reads
// `req.query.companyId`, so senders do put data there, and a `?token=…` is
// one field over from the body with bare `token` equally absent from the
// denylist. So wherever the URL or query reaches a log line (`reqQuery`, the
// message's URL, pino-http's serialized `req`) it is dropped alongside the
// body; `shouldOmitRequestBodyFromLog` governs both.
const UNLOGGABLE_REQUEST_BODY_PATHS = [
  // Both forms are matched on purpose. `httpLogger` is installed app-wide but
  // Express rewrites `req.url` to the mount-relative path while a mounted
  // router is handling the request, and pino-http reads it at response time —
  // so this route is logged as `/plugins/...`, not `/api/plugins/...`. Field
  // evidence: the WARN lines reported on BLO-29716 carry the unprefixed form.
  // Matching both keeps the guard correct if that mount detail ever changes.
  /^(?:\/api)?\/plugins\/[^/]+\/webhooks\/[^/]+(?:\/|$)/,
];

export function shouldOmitRequestBodyFromLog(url: string | undefined): boolean {
  if (!url) return false;
  const pathname = normalizePath(url);
  return UNLOGGABLE_REQUEST_BODY_PATHS.some((pattern) => pattern.test(pathname));
}

const MAX_SUMMARIZED_KEYS = 40;
// Key names on these routes are sender-authored too, so each one is bounded
// as well as the count; otherwise `{"<64 KiB string>": 1}` lands verbatim.
const MAX_SUMMARIZED_KEY_LENGTH = 64;
const OMITTED_QUERY = "[OMITTED: untrusted webhook query]";

function summarizeKeys(field: string, value: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(value).sort();
  const summary: Record<string, unknown> = {
    [`${field}Keys`]: keys
      .slice(0, MAX_SUMMARIZED_KEYS)
      .map((k) => (k.length > MAX_SUMMARIZED_KEY_LENGTH ? `${k.slice(0, MAX_SUMMARIZED_KEY_LENGTH)}…` : k)),
  };
  if (keys.length > MAX_SUMMARIZED_KEYS) summary[`${field}KeysTruncated`] = keys.length - MAX_SUMMARIZED_KEYS;
  return summary;
}

// A bounded stand-in for an omitted body: enough to debug a rejection
// (how big was it, what shape was it) with no sender-supplied value in it.
export function summarizeOmittedRequestBody(body: unknown): Record<string, unknown> {
  const summary: Record<string, unknown> = { reqBody: "[OMITTED: untrusted webhook payload]" };

  let bytes: number | undefined;
  try {
    const serialized = typeof body === "string" ? body : JSON.stringify(body);
    if (typeof serialized === "string") bytes = Buffer.byteLength(serialized, "utf8");
  } catch {
    // Cyclic or otherwise unserializable — report the shape we can see.
  }
  if (bytes !== undefined) summary.reqBodyBytes = bytes;

  if (body && typeof body === "object" && !Array.isArray(body)) {
    Object.assign(summary, summarizeKeys("reqBody", body as Record<string, unknown>));
  } else if (Array.isArray(body)) {
    summary.reqBodyArrayLength = body.length;
  }

  return summary;
}

export function summarizeOmittedRequestQuery(query: unknown): Record<string, unknown> {
  const summary: Record<string, unknown> = { reqQuery: OMITTED_QUERY };
  if (query && typeof query === "object" && !Array.isArray(query)) {
    Object.assign(summary, summarizeKeys("reqQuery", query as Record<string, unknown>));
  }
  return summary;
}

// Structural subsets of what pino-http hands `customProps` (an
// IncomingMessage/ServerResponse that is Express's Request/Response at
// runtime). Kept assignable from those base types so the production call
// site in createHttpLogger needs no cast and stays type-checked.
export type LoggedRequest = {
  url?: string;
  originalUrl?: string;
  body?: unknown;
  params?: unknown;
  query?: unknown;
  route?: { path?: string };
};

export type LoggedResponse = {
  statusCode: number;
  __errorContext?: { error?: unknown; reqBody?: unknown; reqParams?: unknown; reqQuery?: unknown };
};

function hasEntries(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && Object.keys(value as object).length > 0;
}

// Extracted from logger.ts so both the 4xx and 5xx paths are directly
// testable without importing that module, which opens pino transports and
// creates a log directory at import time.
export function buildHttpLogProps(req: LoggedRequest, res: LoggedResponse): Record<string, unknown> {
  if (res.statusCode < 400) return {};

  // Keyed on >= 400, so a readiness guard answering 503 is logged exactly the
  // same way a 400 was. That is why BLO-28659's 400 -> 503 change did not fix
  // this leak, and why the omission below is keyed on the route, not the code.
  const omitSenderInput = shouldOmitRequestBodyFromLog(req.originalUrl ?? req.url);

  const ctx = res.__errorContext;
  if (ctx) {
    return {
      errorContext: ctx.error,
      ...(omitSenderInput
        ? summarizeOmittedRequestBody(ctx.reqBody)
        : { reqBody: redactSensitive(ctx.reqBody) }),
      // reqParams stays: pluginId/endpointKey come from the route path, not
      // from the sender. The query string does not, so it goes with the body.
      reqParams: redactSensitive(ctx.reqParams),
      ...(omitSenderInput
        ? summarizeOmittedRequestQuery(ctx.reqQuery)
        : { reqQuery: redactSensitive(ctx.reqQuery) }),
    };
  }

  const props: Record<string, unknown> = {};
  if (omitSenderInput) {
    Object.assign(props, summarizeOmittedRequestBody(req.body));
  } else if (hasEntries(req.body)) {
    props.reqBody = redactSensitive(req.body);
  }
  if (hasEntries(req.params)) props.reqParams = redactSensitive(req.params);
  if (hasEntries(req.query)) {
    if (omitSenderInput) Object.assign(props, summarizeOmittedRequestQuery(req.query));
    else props.reqQuery = redactSensitive(req.query);
  }
  if (req.route?.path) props.routePath = req.route.path;
  return props;
}

// The URL as it may appear in a log line: query string dropped on routes
// whose sender input is unloggable, untouched everywhere else.
//
// Exported because this middleware is NOT the only place a request URL
// reaches a log line, and the rule above is only a control if every such
// place applies it. `shouldOmitRequestBodyFromLog` governs the body, the
// query and the URL together; a caller that logs a raw `req.originalUrl`
// re-opens the query half of that guard on exactly the untrusted routes it
// exists for. Call this instead of interpolating a URL into a log payload.
//
// Note the argument must be the request-relative URL (`/api/plugins/…`),
// not an absolute one: the route patterns are anchored at the path root, so
// an absolute `http://host/api/plugins/…` matches nothing and would silently
// scrub nothing. Callers building an upstream URL should scrub the relative
// part and concatenate the origin afterwards.
export function urlForLog(url: string | undefined): string | undefined {
  return url !== undefined && shouldOmitRequestBodyFromLog(url) ? normalizePath(url) : url;
}

// Lives here rather than in logger.ts so a test can drive the real pino-http
// wiring over a real Express request with an in-memory pino, without that
// module opening transports and creating a log directory at import time.
export function createHttpLogger(logger: pino.Logger) {
  return pinoHttp({
    logger,
    serializers: {
      // pino-http wraps this around pino-std-serializers' request serializer,
      // so `req` is already the serialized shape: `url` is req.originalUrl —
      // query string included — and `query` the parsed form. Both reach the
      // file target, which does not `ignore` req the way stdout does.
      req(req: { url?: string; query?: unknown }) {
        if (req.url && shouldOmitRequestBodyFromLog(req.url)) {
          req.url = normalizePath(req.url);
          req.query = OMITTED_QUERY;
        }
        return req;
      },
    },
    customLogLevel(req, res, err) {
      if (shouldSilenceHttpSuccessLog(req.method, req.url, res.statusCode)) {
        return "silent";
      }
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    customSuccessMessage(req, res) {
      return `${req.method} ${urlForLog(req.url)} ${res.statusCode}`;
    },
    customErrorMessage(req, res, err) {
      const ctx = (res as any).__errorContext;
      const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
      return `${req.method} ${urlForLog(req.url)} ${res.statusCode} — ${errMsg}`;
    },
    customProps(req, res) {
      return buildHttpLogProps(req, res);
    },
  });
}
