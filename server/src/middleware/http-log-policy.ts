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
    const keys = Object.keys(body as Record<string, unknown>).sort();
    summary.reqBodyKeys = keys.slice(0, MAX_SUMMARIZED_KEYS);
    if (keys.length > MAX_SUMMARIZED_KEYS) {
      summary.reqBodyKeysTruncated = keys.length - MAX_SUMMARIZED_KEYS;
    }
  } else if (Array.isArray(body)) {
    summary.reqBodyArrayLength = body.length;
  }

  return summary;
}

type LoggedRequest = {
  url?: string;
  originalUrl?: string;
  body?: unknown;
  params?: unknown;
  query?: unknown;
  route?: { path?: string };
};

type LoggedResponse = {
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
  const omitBody = shouldOmitRequestBodyFromLog(req.originalUrl ?? req.url);

  const ctx = res.__errorContext;
  if (ctx) {
    return {
      errorContext: ctx.error,
      ...(omitBody
        ? summarizeOmittedRequestBody(ctx.reqBody)
        : { reqBody: redactSensitive(ctx.reqBody) }),
      reqParams: redactSensitive(ctx.reqParams),
      reqQuery: redactSensitive(ctx.reqQuery),
    };
  }

  const props: Record<string, unknown> = {};
  if (omitBody) {
    Object.assign(props, summarizeOmittedRequestBody(req.body));
  } else if (hasEntries(req.body)) {
    props.reqBody = redactSensitive(req.body);
  }
  if (hasEntries(req.params)) props.reqParams = redactSensitive(req.params);
  if (hasEntries(req.query)) props.reqQuery = redactSensitive(req.query);
  if (req.route?.path) props.routePath = req.route.path;
  return props;
}
