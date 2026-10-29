import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PEN-3549 — a WebSocket upgrade URL must not reach a log line raw.
 *
 * The defect this closes was not a missing redaction; it was a redaction that
 * existed and did not spread. `environment-custom-image-terminal-ws.ts` had a
 * module-local `safeUpgradePath` from the day it was written, and
 * `live-events-ws.ts` — the sibling module, same directory, same protocol
 * constraint — logged `{ path: req.url }` raw on two error paths for 33 days.
 * One author saw the hazard; nothing made the second author inherit the answer.
 *
 * An exported helper alone does not fix that: the next author still has to know
 * it exists. This guard is the part that does not depend on them knowing. It
 * fails CI when a module that registers a WS upgrade handler puts a raw
 * `req.url` inside a logger call.
 *
 * Why an upgrade URL specifically, when `urlForLog` already governs HTTP
 * request URLs: a browser `WebSocket` constructor cannot set an
 * `Authorization` header, so `?token=` is the only way a board client can
 * authenticate one of these sockets. The credential is in the query string by
 * protocol necessity, on every upgrade route — not on a route list somebody
 * has to remember to extend. The global pino `redact` in logger.ts names
 * `req.headers.authorization`, which is precisely the form these do not use.
 *
 * ⚠️ Scope, stated so nobody reads more assurance into a green run than it earns:
 *
 *  - It covers files that register an upgrade handler (`COVERED` below is
 *    discovered, not hardcoded, so a NEW upgrade handler anywhere under
 *    `server/src` is covered the day it is written). The known two are asserted
 *    present, so the discovery going empty fails rather than passes silently.
 *  - It matches on identifier TEXT inside a logger call. Copying `req.url` into
 *    a differently-named local first evades it. It is built against the
 *    accidental next module, not against deliberate evasion.
 *  - It says nothing about whether the scrubbed value is correct — that is
 *    `upgradePathForLog`'s own tests in http-log-policy.test.ts.
 *  - The first cases are POSITIVE CONTROLS: they prove the detector fires on a
 *    raw log before the real-source case is allowed to mean anything.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.resolve(here, "..");

const LOG_CALL = /\blogger\s*\.\s*(?:trace|debug|info|warn|error|fatal)\s*\(/g;
const RAW_REQUEST_URL = /\b(?:req|request|rawReq|incoming)\s*\.\s*url\b/;
// A URL handed TO the scrubber is the fixed form, not the defect, so the
// helper's own argument is removed before the payload is tested.
const SCRUBBED = /\bupgradePathForLog\s*\([^)]*\)/g;

/** The text of the balanced-paren argument list starting at `openParen`. */
function argumentText(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  return source.slice(openParen + 1);
}

/** Logger calls in `source` whose payload carries a raw request URL. */
function rawUrlLogCalls(source: string): string[] {
  const offenders: string[] = [];
  for (const match of source.matchAll(LOG_CALL)) {
    const open = match.index + match[0].length - 1;
    const payload = argumentText(source, open).replace(SCRUBBED, "");
    if (RAW_REQUEST_URL.test(payload)) {
      offenders.push(payload.replace(/\s+/g, " ").trim().slice(0, 160));
    }
  }
  return offenders;
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...tsFilesUnder(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

const REGISTERS_UPGRADE = /\.on\s*\(\s*["'`]upgrade["'`]|\bhandleUpgrade\s*\(/;

const COVERED = tsFilesUnder(serverSrc)
  .map((file) => ({ file, source: readFileSync(file, "utf8") }))
  .filter(({ source }) => REGISTERS_UPGRADE.test(source))
  .map(({ file, source }) => ({ rel: path.relative(serverSrc, file), source }));

describe("ws upgrade URL log guard — positive controls", () => {
  it("fires on a raw req.url in a logger payload", () => {
    const offenders = rawUrlLogCalls(
      'logger.warn({ err, path: req.url }, "live websocket upgrade socket error");',
    );
    expect(offenders).toHaveLength(1);
  });

  it("fires across a multi-line logger call, not just a one-liner", () => {
    const offenders = rawUrlLogCalls(
      ["logger.error(", "  { err, path: req.url },", '  "failed",', ");"].join("\n"),
    );
    expect(offenders).toHaveLength(1);
  });

  it("does not fire on the scrubbed form, inline or via a local", () => {
    expect(rawUrlLogCalls('logger.warn({ path: upgradePathForLog(req.url) }, "x");')).toEqual([]);
    expect(rawUrlLogCalls('logger.warn({ path: logPath }, "x");')).toEqual([]);
  });

  it("does not fire on a req.url read that is not a log call", () => {
    expect(rawUrlLogCalls('const url = new URL(req.url, "http://localhost");')).toEqual([]);
  });
});

describe("ws upgrade URL log guard — real source", () => {
  it("discovers the modules that register an upgrade handler", () => {
    const rels = COVERED.map((c) => c.rel);
    // Asserted so the scan going empty — a refactor, a moved file — fails
    // loudly instead of passing as "nothing to check".
    expect(rels).toContain(path.join("realtime", "live-events-ws.ts"));
    expect(rels).toContain(path.join("realtime", "environment-custom-image-terminal-ws.ts"));
  });

  it.each(COVERED.map((c) => c.rel))("logs no raw request URL in %s", (rel) => {
    const covered = COVERED.find((c) => c.rel === rel);
    expect(rawUrlLogCalls(covered!.source)).toEqual([]);
  });
});
