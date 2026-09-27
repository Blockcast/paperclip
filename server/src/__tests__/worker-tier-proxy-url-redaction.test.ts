// PEN-2996 — the untrusted-webhook query string must not reach a log line
// from the worker-tier proxy either.
//
// BLO-29716 established the invariant that on plugin webhook routes the body,
// the query and the URL are all sender-authored and none of them may be
// logged: `shouldOmitRequestBodyFromLog` governs all three, and the HTTP
// logger drops each of them together. The worker-tier proxy is a SECOND place
// a request URL reaches a log line, and it was interpolating the raw
// `req.originalUrl` — query string included — into three `logger.warn` /
// `logger.error` payloads. Those fire on proxy retry, on a worker 5xx and on
// a relay failure, so a `?token=…` on a webhook URL was written in the clear
// on exactly the routes the guard exists for.
//
// The proxy is also the reason this matters on BOTH tiers: it forwards
// `req.originalUrl` verbatim to the worker, so the worker logs the same path
// and the same guard has to hold at each hop.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logRecord = vi.hoisted(() => ({
  error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { ...logRecord, child: vi.fn(() => logRecord) },
}));

import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { registerWorkerTierProxyRoutes } from "../routes/worker-tier-proxy.js";

// A value that must never appear in a log payload. Distinct from the
// http-log-policy sentinels so a failure names which surface leaked.
const QUERY_SENTINEL = "proxy-qs-sentinel-verification-token-do-not-log";

const WEBHOOK_PATH = "/api/plugins/slack/webhooks/slack-events";

function startWorkerStub(status: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function buildApp(workersUrl: string) {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerWorkerTierProxyRoutes(router, workersUrl);
  app.use("/api", router);
  return app;
}

/** Every argument of every log call this test triggered, as one string. */
function loggedPayload(): string {
  return [...logRecord.warn.mock.calls, ...logRecord.error.mock.calls]
    .map((args) => JSON.stringify(args, (_k, v) => (v instanceof Error ? v.message : v)))
    .join("\n");
}

describe("worker-tier proxy — webhook query string never reaches a log line", () => {
  let stub: { url: string; close: () => Promise<void> } | null = null;

  beforeEach(() => {
    logRecord.warn.mockClear();
    logRecord.error.mockClear();
  });

  afterEach(async () => {
    await stub?.close();
    stub = null;
  });

  it("scrubs the query string from the 5xx-relay warning on a webhook route", async () => {
    stub = await startWorkerStub(500);

    await request(buildApp(stub.url))
      .post(`${WEBHOOK_PATH}?companyId=c1&token=${QUERY_SENTINEL}`)
      .send({ type: "event_callback" });

    const payload = loggedPayload();
    // Positive control: the warning fired at all. Without this an assertion
    // that the sentinel is absent passes vacuously when nothing was logged,
    // which is the failure mode that would hide a regression here.
    expect(payload).toContain("worker tier returned a server error");
    expect(payload).not.toContain(QUERY_SENTINEL);
    // The path itself is kept — it is the diagnostic that makes the line
    // worth having, and a route path is not sender-authored.
    expect(payload).toContain(WEBHOOK_PATH);
  });

  it("scrubs the query string from the relay-failure error when the worker is unreachable", async () => {
    // Point at a port nothing is listening on so the fetch rejects.
    const dead = await startWorkerStub(500);
    const deadUrl = dead.url;
    await dead.close();

    await request(buildApp(deadUrl))
      .post(`${WEBHOOK_PATH}?companyId=c1&token=${QUERY_SENTINEL}`)
      .send({ type: "event_callback" });

    const payload = loggedPayload();
    expect(payload).toContain("failed to relay request to worker tier");
    expect(payload).not.toContain(QUERY_SENTINEL);
  });

  it("leaves the query string intact on a NON-webhook proxied route", async () => {
    // Guard against over-reach: the scrub is scoped to routes whose input is
    // sender-authored. Operator-facing plugin routes keep their query string,
    // which is why this is a targeted guard and not a blanket URL blank.
    stub = await startWorkerStub(500);

    await request(buildApp(stub.url))
      .post(`/api/plugins/slack/enable?companyId=c1&trace=keep-me-visible`)
      .send({});

    const payload = loggedPayload();
    expect(payload).toContain("worker tier returned a server error");
    expect(payload).toContain("trace=keep-me-visible");
  });
});
