import express, { type Express } from "express";

import { DEFAULT_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT } from "./body-limits.js";

/**
 * body-parser `verify` hook that stashes the exact raw request bytes on
 * `req.rawBody`. Downstream webhook handlers (GitHub, Slack, Linear, …)
 * verify provider HMAC signatures over these original bytes — re-serializing
 * `req.body` would change whitespace/key-order and break verification.
 *
 * `verify` is invoked by whichever parser's content-type matched the request,
 * so a JSON request captures its JSON bytes and a urlencoded request captures
 * its `payload=<…>` bytes; each request's raw body is captured exactly once.
 */
export function captureRawBody(
  req: express.Request,
  _res: express.Response,
  buf: Buffer,
): void {
  (req as unknown as { rawBody: Buffer }).rawBody = buf;
}

/**
 * Register the standard inbound body parsers with raw-body capture.
 *
 * Order matters:
 *  1. The company-import path gets a larger JSON limit and must be registered
 *     before the generic JSON parser so the larger limit wins for that path.
 *  2. The generic JSON parser handles `application/json` (most API + webhook
 *     traffic, e.g. Slack Events API).
 *  3. The urlencoded parser handles `application/x-www-form-urlencoded`, which
 *     Slack uses for interactivity (`payload=<json>`) and slash commands.
 *     Without it those POSTs match no parser: `req.rawBody` stays empty and
 *     `req.body` stays `{}`, so the Slack HMAC is computed over an empty body
 *     and Block Kit buttons are rejected with `hmac_mismatch` (BLO-8857).
 *
 * Each parser only consumes a request whose Content-Type matches, so the three
 * are mutually exclusive per request and never double-capture `rawBody`.
 */
export function registerBodyParsers(
  app: Express,
  opts: { companyImportPath: string },
): void {
  app.use(
    opts.companyImportPath,
    express.json({ limit: PORTABLE_JSON_BODY_LIMIT, verify: captureRawBody }),
  );
  app.use(
    express.json({ limit: DEFAULT_JSON_BODY_LIMIT, verify: captureRawBody }),
  );
  app.use(
    express.urlencoded({
      extended: false,
      limit: DEFAULT_JSON_BODY_LIMIT,
      verify: captureRawBody,
    }),
  );
}
