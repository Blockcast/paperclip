// Guard tests for the raw-NUL body rejection (BLO-40398).
//
// Baseline measured live 2026-10-06 before the fix: a raw 0x00 in the document
// body, issue title, issue description, or comment body all returned
// `500 {"error":"Internal server error"}`, naming nothing, and all four failed
// closed. These tests pin the replacement: a 400 that names the field and the
// byte offset, the handler never reached, and a body carrying the SIX-character
// JSON NUL escape still passing through byte-identical.
//
// NOTE: this file must contain no raw 0x00 byte of its own -- that is the
// BLO-39632 defect, and scripts/check-no-raw-nul.mjs fails on it in CI. Every
// NUL below is built at runtime from the escape, never embedded as a byte.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { registerBodyParsers } from "../http/body-parsers.js";
import { findRawNulInBody } from "../http/raw-nul-guard.js";
import { errorHandler } from "../middleware/error-handler.js";

/** The six literal characters of a JSON NUL escape: backslash, u, 0, 0, 0, 0. */
const NUL_ESCAPE = "\\u0000";
/** One real 0x00, built at runtime so no raw byte lands in this file. */
const NUL = JSON.parse(`"${NUL_ESCAPE}"`) as string;

/** App mounting only the shared parser stack, an echo route, and the error handler. */
function buildApp() {
  const app = express();
  const reached: string[] = [];
  registerBodyParsers(app);
  app.post("/echo", (req, res) => {
    reached.push("echo");
    res.json({ body: req.body });
  });
  // Same path shape as the real inbound provider-webhook route, which the guard
  // deliberately leaves alone.
  app.post("/api/plugins/:pluginId/webhooks/:endpointKey", (req, res) => {
    reached.push("webhook");
    res.json({ body: req.body });
  });
  app.use(errorHandler);
  return { app, reached };
}

describe("findRawNulInBody", () => {
  it("names a top-level field and its byte offset", () => {
    expect(findRawNulInBody({ title: `ab${NUL}cd` })).toEqual({
      field: "body.title",
      byteOffset: 2,
    });
  });

  it("walks into nested objects and arrays to name the path", () => {
    const hit = findRawNulInBody({
      sections: [{ rows: [{ text: "clean" }, { text: `x${NUL}` }] }],
    });
    expect(hit).toEqual({ field: "body.sections[0].rows[1].text", byteOffset: 1 });
  });

  it("reports a UTF-8 BYTE offset, not the UTF-16 index", () => {
    // Four 3-byte characters then the NUL: UTF-16 index 4, byte offset 12.
    const hit = findRawNulInBody({ body: `你好世界${NUL}` });
    expect(hit).toEqual({ field: "body.body", byteOffset: 12 });
  });

  it("does not flag text holding the six-character escape", () => {
    expect(findRawNulInBody({ body: `prose ${NUL_ESCAPE} prose` })).toBeNull();
  });

  it("does not flag a binary Buffer body, where 0x00 is payload", () => {
    expect(findRawNulInBody(Buffer.from([0x01, 0x00, 0x02]))).toBeNull();
    expect(findRawNulInBody({ blob: new Uint8Array([0x00]) })).toBeNull();
  });

  it("skips a large Buffer instead of enumerating it per byte", () => {
    // Availability guard, not correctness: a Buffer's entries are numbers, so
    // the string branch could never flag one. But without the typed-array skip
    // Object.entries materializes one entry per byte -- measured 7355 ms for
    // 4 MB, on the event loop, reachable from any binary body under the 10 MB
    // parser limit. The bound is ~28000x the measured skipped cost (0.26 ms),
    // so it is not a timing race.
    const started = Date.now();
    expect(findRawNulInBody(Buffer.alloc(4 * 1024 * 1024, 1))).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("returns null for a clean body", () => {
    expect(findRawNulInBody({ a: 1, b: "ok", c: [null, true, { d: "ok" }] })).toBeNull();
  });
});

describe("registerBodyParsers raw-NUL guard", () => {
  // The four routes measured 500 before the fix all converge on this stack, so
  // one shape per text-field kind is enough: title, description, body.
  for (const field of ["title", "description", "body"]) {
    it(`rejects a raw NUL in ${field} with a 400 naming the field and byte offset`, async () => {
      const { app, reached } = buildApp();

      const res = await request(app)
        .post("/echo")
        .set("content-type", "application/json")
        .send(`{"${field}":"ab${NUL_ESCAPE}cd"}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("raw_nul_in_text");
      expect(res.body.details).toMatchObject({ field: `body.${field}`, byteOffset: 2 });
      expect(res.body.error).toContain(`body.${field}`);
      expect(res.body.error).toContain("byte offset 2");
      // Fail closed: the handler that would have written the row never ran.
      expect(reached).toEqual([]);
    });
  }

  it("passes a body carrying the six-character escape through byte-identical", async () => {
    const { app, reached } = buildApp();
    const stored = `escape test: [${NUL_ESCAPE}] end`;

    const res = await request(app)
      .post("/echo")
      .set("content-type", "application/json")
      .send(JSON.stringify({ body: stored }));

    expect(res.status).toBe(200);
    expect(res.body.body.body).toBe(stored);
    expect(res.body.body.body).not.toContain(NUL);
    expect(reached).toEqual(["echo"]);
  });

  it("leaves a clean body alone", async () => {
    const { app, reached } = buildApp();

    const res = await request(app)
      .post("/echo")
      .set("content-type", "application/json")
      .send(JSON.stringify({ title: "ordinary" }));

    expect(res.status).toBe(200);
    expect(reached).toEqual(["echo"]);
  });

  it("rejects a NUL arriving urlencoded as %00, which carries no JSON escape", async () => {
    const { app, reached } = buildApp();

    const res = await request(app)
      .post("/echo")
      .set("content-type", "application/x-www-form-urlencoded")
      .send("title=ab%00cd");

    expect(res.status).toBe(400);
    expect(res.body.details).toMatchObject({ field: "body.title", byteOffset: 2 });
    expect(reached).toEqual([]);
  });

  it("leaves inbound provider-webhook deliveries unguarded", async () => {
    // Third-party bytes, and a NUL label is reachable from Alertmanager. Whether
    // the jsonb payload insert survives it is unmeasured, so this guard must not
    // newly reject a delivery that works today. See UNGUARDED_PATHS.
    const { app, reached } = buildApp();

    const res = await request(app)
      .post("/api/plugins/p1/webhooks/alerts")
      .set("content-type", "application/json")
      .send(`{"alertname":"A${NUL_ESCAPE}B"}`);

    expect(res.status).toBe(200);
    expect(res.body.body.alertname).toBe(`A${NUL}B`);
    expect(reached).toEqual(["webhook"]);
  });
});
