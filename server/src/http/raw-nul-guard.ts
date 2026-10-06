// Reject a raw NUL (0x00) in any string reachable from a parsed JSON request
// body, with a 400 that names the field and the byte offset (BLO-40398).
//
// Postgres cannot store 0x00 inside a `text` column, so such a write used to
// surface as a bare `500 {"error":"Internal server error"}` naming nothing.
// Measured 2026-10-06, all four 500 and all four fail closed:
//
//   PUT   /api/issues/:id/documents/:key   (body)
//   POST  /api/companies/:id/issues        (title)
//   PATCH /api/issues/:id                  (description)
//   POST  /api/issues/:id/comments         (body)
//
// Mounted once in registerBodyParsers rather than per route, because the set of
// text columns reachable by a write is open-ended: four per-route patches would
// still have missed the fifth.
//
// How the NUL gets there, which is what the message has to explain. The stored
// text holds the SIX literal characters of a JSON NUL escape (backslash, `u`,
// `0`, `0`, `0`, `0`). The read path is lossless — verified byte-exactly: the
// wire form doubles the backslash, so a verbatim round-trip over raw HTTP both
// stores and returns those six characters. What breaks is a *writer* that reads
// the rendered JSON, decodes it one level in its head, and then re-emits it one
// escape level short: the write's own JSON layer then collapses that
// six-character escape into a real NUL. So the body is the thing at fault, and
// nothing in the old 500 said so.

import type express from "express";
import { badRequest } from "../errors.js";

const NUL = "\u0000";

/**
 * First raw NUL reachable from `body`, as a dotted/indexed path and the UTF-8
 * byte offset within that string. Iterative so a deeply nested body cannot
 * overflow the stack — a 10 MB body of nested arrays is within the JSON limit.
 */
export function findRawNulInBody(
  body: unknown,
): { field: string; byteOffset: number } | null {
  const stack: Array<{ node: unknown; path: string }> = [{ node: body, path: "body" }];
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;

    if (typeof node === "string") {
      const index = node.indexOf(NUL);
      if (index >= 0) {
        return { field: path, byteOffset: Buffer.byteLength(node.slice(0, index), "utf8") };
      }
      continue;
    }

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) {
        stack.push({ node: node[i], path: `${path}[${i}]` });
      }
      continue;
    }

    // A Buffer / typed array is what express.raw leaves behind for a binary
    // content-type. Skipping it is an AVAILABILITY guard, not a correctness one:
    // a Buffer's own entries are numbers, so the string branch above could never
    // flag one anyway -- but Object.entries would materialize one entry per
    // byte. Measured: a 4 MB Buffer takes 0.26 ms with this clause and 7355 ms
    // without, on the event loop, for any binary body up to the 10 MB limit.
    if (node === null || typeof node !== "object" || ArrayBuffer.isView(node)) continue;

    for (const [key, child] of Object.entries(node)) {
      stack.push({ node: child, path: `${path}.${key}` });
    }
  }
  return null;
}

/**
 * Inbound provider-webhook deliveries, deliberately NOT guarded.
 *
 * These carry third-party bytes, and a NUL in one is reachable in production:
 * `server/src/__tests__/plugin-metric-exposition.test.ts` records that
 * `alertname`/`severity` are verbatim Alertmanager labels and that "JSON.parse
 * of a body containing a NUL escape yields that code point intact" — and the
 * metric path already strips control characters rather than failing.
 *
 * Whether such a delivery survives its own `jsonb` payload insert today is
 * UNMEASURED from here (no reachable database), so this guard does not change
 * that path in either direction. If it turns out to 500 on insert, widening the
 * guard to cover it is a one-line change and an improvement; asserting that
 * now, and newly rejecting a delivery that currently works, is not.
 */
const UNGUARDED_PATHS = [/^\/api\/plugins\/[^/]+\/webhooks\//];

/** 400 instead of 500 when the parsed body carries a raw NUL. */
export function rejectRawNulInBody(): express.RequestHandler {
  return (req, _res, next) => {
    if (UNGUARDED_PATHS.some((pattern) => pattern.test(req.path))) {
      next();
      return;
    }
    const hit = findRawNulInBody(req.body);
    if (!hit) {
      next();
      return;
    }
    next(
      badRequest(
        `Request body contains a raw NUL (0x00) at ${hit.field}, byte offset ${hit.byteOffset}. ` +
          "Text columns cannot store it. If this value was read back from Paperclip, the stored " +
          "text holds the six-character JSON escape and your write dropped an escape level — " +
          "send a doubled backslash so the escape survives JSON decoding.",
        { code: "raw_nul_in_text", field: hit.field, byteOffset: hit.byteOffset },
      ),
    );
  };
}
