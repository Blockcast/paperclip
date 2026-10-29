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
 *  - It matches on identifier TEXT, with ONE hop: a local assigned the raw URL
 *    (`const p = req.url`) is tainted and flagged where it is logged. Both
 *    covered modules log through such a local, so without the hop the likeliest
 *    regression in either — dropping the `upgradePathForLog` call and keeping
 *    the local — read as clean. TWO hops (`const a = req.url; const b = a;`)
 *    still evade it, as does any laundering through a call. It is built against
 *    the accidental next module, not against deliberate evasion.
 *  - The logger receiver is matched by NAME, over any identifier ending in
 *    `log`/`logger` (case-insensitive) — bare `logger`, a `log` child, a
 *    `wsLogger`. A logger reached under some other name (`this.obs.warn`, a
 *    destructured `{ warn }`) is still invisible. The widening was measured,
 *    not guessed: `log.<level>(` is 233 of the ~1259 logging call sites under
 *    server/src, so the previous single-spelling detector was blind to about a
 *    fifth of the repo's own idiom.
 *  - It says nothing about whether the scrubbed value is correct — that is
 *    `upgradePathForLog`'s own tests in http-log-policy.test.ts.
 *  - The first cases are POSITIVE CONTROLS: they prove the detector fires on a
 *    raw log before the real-source case is allowed to mean anything.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.resolve(here, "..");

// Any identifier a logger is plausibly bound to, not just the literal
// `logger`. A child logger is the ordinary way to add module context
// (`const log = logger.child({ mod: "x" })`), and `log.<level>(` is the
// second-most-common logging shape in server/src — 233 call sites against
// 1014 for bare `logger`, plus `defaultLogger` and `pluginLogger`. Keying
// the detector on one spelling would have left ~19% of the repo's own
// logging idiom invisible to it, so a next author who reached for the child
// logger — the accidental shape this guard exists for, not an evasive one —
// would have inherited no protection at all.
const LOG_CALL =
  /\b(?:[A-Za-z_$][A-Za-z0-9_$]*)?(?:logger|log)\s*\.\s*(?:trace|debug|info|warn|error|fatal)\s*\(/gi;
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

// A local the raw request URL was assigned to, one hop. Both covered modules
// log via a `const logPath = upgradePathForLog(req.url)` local rather than
// inline, so without this the most likely regression in either of them —
// dropping the helper call and keeping the local — reads as clean. That was
// not a hypothetical: it is the mutation this guard failed to catch before
// the hop was added.
const TAINTING_ASSIGNMENT =
  /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([^;\n]*)/g;

/** Identifiers assigned a raw request URL that the scrubber did not launder. */
function taintedLocals(source: string): Set<string> {
  const tainted = new Set<string>();
  for (const match of source.matchAll(TAINTING_ASSIGNMENT)) {
    const name = match[1];
    const rhs = (match[2] ?? "").replace(SCRUBBED, "");
    if (name && RAW_REQUEST_URL.test(rhs)) tainted.add(name);
  }
  return tainted;
}

// Whole-identifier match for a name taken out of source text. `\b` is wrong
// here on two counts: `$` is legal in a JS identifier but is a non-word
// character, so `\b$logPath` never matches (no boundary between a space and a
// `$`), and `$` is also a regex metacharacter. Both failures are silent and
// fail OPEN — the guard simply stops seeing that local — which is the one
// direction a security guard must not fail in. Lookarounds over the
// identifier character class get both right.
function identifierPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
}

/** Logger calls in `source` whose payload carries a raw request URL. */
function rawUrlLogCalls(source: string): string[] {
  const offenders: string[] = [];
  const tainted = taintedLocals(source);
  for (const match of source.matchAll(LOG_CALL)) {
    const open = match.index + match[0].length - 1;
    const payload = argumentText(source, open).replace(SCRUBBED, "");
    const carriesTaintedLocal = [...tainted].some((name) =>
      identifierPattern(name).test(payload),
    );
    if (RAW_REQUEST_URL.test(payload) || carriesTaintedLocal) {
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

  // The detector used to key on the literal identifier `logger`, which left
  // the child-logger shape — 233 call sites in server/src — completely
  // invisible to it. These are the shapes a next author actually reaches for.
  it.each([
    ["child logger bound to `log`", 'log.warn({ err, path: req.url }, "x");'],
    ["member child logger", 'this.log.error({ path: req.url }, "x");'],
    ["named child logger", 'wsLogger.warn({ path: req.url }, "x");'],
    ["module default logger", 'defaultLogger.info({ path: req.url }, "x");'],
    ["plugin logger", 'pluginLogger.debug({ path: req.url }, "x");'],
  ])("fires on a raw req.url logged via a %s", (_label, source) => {
    expect(rawUrlLogCalls(source)).toHaveLength(1);
  });

  it("still ignores a scrubbed payload on a child logger", () => {
    expect(rawUrlLogCalls('log.warn({ path: upgradePathForLog(req.url) }, "x");')).toEqual([]);
  });

  // The one-hop taint. This is the shape BOTH covered modules actually use,
  // so it is the shape a regression in them would take.
  it("fires on a raw URL laundered through a local before the log call", () => {
    const source = ["const logPath = req.url;", 'logger.warn({ path: logPath }, "x");'].join("\n");
    expect(rawUrlLogCalls(source)).toHaveLength(1);
  });

  it("does not fire when that same local came from the scrubber", () => {
    const source = [
      "const logPath = upgradePathForLog(req.url);",
      'logger.warn({ path: logPath }, "x");',
    ].join("\n");
    expect(rawUrlLogCalls(source)).toEqual([]);
  });

  // A parsed URL still serialises its query, so tainting it is correct rather
  // than over-eager — this is a true positive waiting to happen, not noise.
  it("treats a parsed URL object built from req.url as tainted", () => {
    const source = [
      'const url = new URL(req.url, "http://localhost");',
      'logger.info({ url }, "x");',
    ].join("\n");
    expect(rawUrlLogCalls(source)).toHaveLength(1);
  });

  it("does not taint an unrelated local that merely shares a prefix", () => {
    const source = ["const logPath = req.url;", 'logger.warn({ path: logPathSafe }, "x");'].join("\n");
    expect(rawUrlLogCalls(source)).toEqual([]);
  });

  // `$` is legal in a JS identifier and is a regex metacharacter. Unescaped it
  // compiles to an anchor that never matches, which would be a silent
  // fail-open rather than a crash.
  it("tracks a tainted local whose name contains a regex metacharacter", () => {
    const source = ["const $logPath = req.url;", 'logger.warn({ path: $logPath }, "x");'].join("\n");
    expect(rawUrlLogCalls(source)).toHaveLength(1);
  });

  // The widened identifier prefix does admit a residual over-match: an object
  // whose name merely ends in `log` (`catalog.info(...)`) is indistinguishable
  // from a logger by text alone. That is left deliberately — a false positive
  // costs an author one look at a line that does contain a raw `req.url`
  // inside an upgrade-registering module, which is the fail-closed direction.
  // These assert the over-match stops short of the common non-logger shapes.
  it("does not fire on calls that are not a <logger>.<level>( shape", () => {
    expect(rawUrlLogCalls("console.log(req.url);")).toEqual([]);
    expect(rawUrlLogCalls("catalog.find({ path: req.url });")).toEqual([]);
    expect(rawUrlLogCalls("dialog.open({ path: req.url });")).toEqual([]);
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
