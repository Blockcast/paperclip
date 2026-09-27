import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  buildHttpLogProps,
  createHttpLogger,
  shouldOmitRequestBodyFromLog,
  shouldSilenceHttpSuccessLog,
  urlForLog,
} from "../middleware/http-log-policy.js";

describe("shouldSilenceHttpSuccessLog", () => {
  it("silences cached 304 responses", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/issues/PAP-1383", 304)).toBe(true);
  });

  it("silences successful polling endpoints", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 200)).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/heartbeat-runs",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/heartbeat-runs/b7044268-19b6-4b3a-a9f3-9c57dce70253/log?offset=1103894&limitBytes=256000",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/live-runs?minCount=3",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "HEAD",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/sidebar-badges",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/issues?includeRoutineExecutions=true",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/activity",
        200,
      ),
    ).toBe(true);
  });

  it("silences successful static asset requests", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/index.html", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/@fs/Users/dotta/paperclip/ui/src/main.tsx", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/src/App.tsx?t=123", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/site.webmanifest", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/sw.js", 200)).toBe(true);
  });

  it("keeps normal successful application requests", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/issues/PAP-1383", 200)).toBe(false);
    expect(shouldSilenceHttpSuccessLog("PATCH", "/api/issues/PAP-1383", 200)).toBe(false);
  });

  it("keeps failing requests visible", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 500)).toBe(false);
    expect(shouldSilenceHttpSuccessLog("GET", "/@fs/Users/dotta/paperclip/ui/src/main.tsx", 404)).toBe(false);
  });
});

// BLO-29716: plugin webhook rejections logged the whole inbound body at WARN.
// Slack's event envelope carries its verification token under a top-level
// `token`, so a live static credential was written to worker stdout on every
// rejected delivery (measured at 9/minute, 15 days running).
describe("shouldOmitRequestBodyFromLog", () => {
  it("omits the body for plugin webhook ingress", () => {
    expect(shouldOmitRequestBodyFromLog("/api/plugins/slack/webhooks/slack-events")).toBe(true);
  });

  it("omits it on the mount-relative path too, which is the form actually logged", () => {
    // httpLogger is app-wide but Express rewrites req.url while a mounted
    // router is handling the request; the WARN lines on BLO-29716 show
    // `/plugins/...`. A guard matching only the `/api` form would no-op.
    expect(shouldOmitRequestBodyFromLog("/plugins/slack/webhooks/slack-events")).toBe(true);
  });

  it("ignores the query string when matching", () => {
    expect(shouldOmitRequestBodyFromLog("/plugins/slack/webhooks/slack-events?companyId=abc")).toBe(true);
  });

  it("leaves ordinary routes logging their bodies", () => {
    expect(shouldOmitRequestBodyFromLog("/api/issues/BLO-1")).toBe(false);
    expect(shouldOmitRequestBodyFromLog("/api/plugins/slack")).toBe(false);
    expect(shouldOmitRequestBodyFromLog("/api/plugins/slack/config")).toBe(false);
    expect(shouldOmitRequestBodyFromLog(undefined)).toBe(false);
  });
});

// PEN-2996: this middleware is not the only place a request URL reaches a log
// line — the worker-tier proxy logs one too — so the rule is exported rather
// than reimplemented at each call site.
describe("urlForLog", () => {
  it("drops the query string on untrusted webhook routes", () => {
    expect(urlForLog("/api/plugins/slack/webhooks/slack-events?companyId=c1&token=shh"))
      .toBe("/api/plugins/slack/webhooks/slack-events");
  });

  it("keeps the query string everywhere else", () => {
    expect(urlForLog("/api/issues?cursor=abc")).toBe("/api/issues?cursor=abc");
  });

  it("passes undefined through so callers can log an absent URL as absent", () => {
    expect(urlForLog(undefined)).toBeUndefined();
  });

  it("does NOT match an absolute URL, which is why callers scrub before prepending an origin", () => {
    // The route patterns are anchored at the path root. Handing this an
    // already-absolute upstream URL would silently scrub nothing — the trap
    // the worker-tier proxy has to avoid when building its target URL.
    const absolute = "http://worker:3000/api/plugins/slack/webhooks/slack-events?token=shh";
    expect(urlForLog(absolute)).toBe(absolute);
  });
});

const SENTINEL = "xoxb-sentinel-verification-token-do-not-log";
const QUERY_SENTINEL = "qs-sentinel-verification-token-do-not-log";
const slackBody = {
  token: SENTINEL,
  type: "event_callback",
  team_id: "T123",
  event: { type: "message", text: "hi" },
};
// This route reads `req.query.companyId`, so senders do put data in the query
// string on these URLs; a `?token=` there is the body leak one field over.
const slackQuery = { companyId: "c1", token: QUERY_SENTINEL };

describe("buildHttpLogProps — no credential reaches a rejection log line", () => {

  // Both statuses are exercised because customProps keys on `>= 400`, not on
  // 4xx. BLO-28659 moved the readiness guard from 400 to 503; if the guarantee
  // were coupled to one status code that change would have silently
  // reintroduced the leak. It must hold on whichever code the guard returns.
  for (const statusCode of [400, 503]) {
    it(`omits the Slack verification token on a ${statusCode} rejection`, () => {
      const props = buildHttpLogProps(
        { url: "/plugins/slack/webhooks/slack-events", body: slackBody, query: slackQuery },
        { statusCode },
      );

      expect(JSON.stringify(props)).not.toContain(SENTINEL);
      expect(JSON.stringify(props)).not.toContain(QUERY_SENTINEL);
      expect(props.reqBody).toBe("[OMITTED: untrusted webhook payload]");
      expect(props.reqQuery).toBe("[OMITTED: untrusted webhook query]");
    });

    it(`omits it on the ${statusCode} error-handler path as well`, () => {
      // The error handler stashes its own copy on res.__errorContext; that is
      // a second branch and needs the same guard.
      const props = buildHttpLogProps(
        { url: "/plugins/slack/webhooks/slack-events" },
        {
          statusCode,
          __errorContext: { error: { message: "boom" }, reqBody: slackBody, reqQuery: slackQuery },
        },
      );

      expect(JSON.stringify(props)).not.toContain(SENTINEL);
      expect(JSON.stringify(props)).not.toContain(QUERY_SENTINEL);
      expect(props.reqBody).toBe("[OMITTED: untrusted webhook payload]");
      expect(props.reqQuery).toBe("[OMITTED: untrusted webhook query]");
    });
  }

  it("is not Slack-specific: an arbitrarily-named credential is omitted too", () => {
    // The point of omitting rather than denylisting. `x_partner_signing_key`
    // is on no list and never will be, because the next plugin invents it.
    const props = buildHttpLogProps(
      {
        url: "/plugins/acme/webhooks/inbound",
        body: { x_partner_signing_key: SENTINEL, nested: { also_secret: SENTINEL } },
      },
      { statusCode: 503 },
    );

    expect(JSON.stringify(props)).not.toContain(SENTINEL);
  });

  it("keeps the rejection debuggable — size and shape, never values", () => {
    const props = buildHttpLogProps(
      { url: "/plugins/slack/webhooks/slack-events", body: slackBody, query: slackQuery, params: { pluginId: "slack" } },
      { statusCode: 503 },
    );

    expect(props.reqBodyKeys).toEqual(["event", "team_id", "token", "type"]);
    expect(props.reqBodyBytes).toBe(Buffer.byteLength(JSON.stringify(slackBody), "utf8"));
    expect(props.reqQueryKeys).toEqual(["companyId", "token"]);
    // Route params are ours (pluginId/endpointKey from the path), not the sender's.
    expect(props.reqParams).toEqual({ pluginId: "slack" });
  });

  it("bounds the length of each summarized key, since key names are sender-authored too", () => {
    const longKey = "k".repeat(500);
    const props = buildHttpLogProps(
      { url: "/plugins/acme/webhooks/inbound", body: { [longKey]: 1 }, query: { [longKey]: "v" } },
      { statusCode: 503 },
    );

    expect(JSON.stringify(props)).not.toContain(longKey);
    expect((props.reqBodyKeys as string[])[0]).toHaveLength(65); // 64 chars + ellipsis
    expect((props.reqQueryKeys as string[])[0]).toHaveLength(65);
  });

  it("still logs and redacts bodies and queries on non-webhook routes", () => {
    const props = buildHttpLogProps(
      {
        url: "/api/auth/sign-in/email",
        body: { email: "a@b.co", password: "hunter2" },
        query: { cursor: "abc", access_token: "t" },
      },
      { statusCode: 400 },
    );

    expect(props.reqBody).toEqual({ email: "a@b.co", password: "[REDACTED]" });
    expect(props.reqQuery).toEqual({ cursor: "abc", access_token: "[REDACTED]" });
  });

  it("logs nothing extra for a successful response", () => {
    expect(buildHttpLogProps({ url: "/plugins/slack/webhooks/slack-events", body: slackBody }, { statusCode: 200 })).toEqual({});
  });
});

// The seam the unit tests above cannot see: does the object pino-http actually
// hands customProps match what buildHttpLogProps expects, and does the whole
// emitted line — message, serialized `req`, custom props — stay clean? Drive
// the real wiring over a real Express request instead of hand-built literals.
describe("httpLogger over a real webhook rejection", () => {
  function captureLogger() {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    return { logger: pino({ level: "debug" }, sink), lines };
  }

  function buildApp(logger: pino.Logger, statusCode: number) {
    const app = express();
    app.use(express.json());
    app.use(createHttpLogger(logger));
    // Mounted the way app.ts mounts the API so req.url is rewritten to the
    // mount-relative form at response time, exactly as in production.
    const api = express.Router();
    api.post("/plugins/:pluginId/webhooks/:endpointKey", (_req, res) => {
      res.status(statusCode).json({ error: "rejected" });
    });
    api.post("/issues", (_req, res) => {
      res.status(400).json({ error: "bad" });
    });
    app.use("/api", api);
    return app;
  }

  async function httpLine(lines: string[]) {
    await vi.waitFor(() => {
      expect(lines.some((line) => line.includes('"res":'))).toBe(true);
    });
    return JSON.parse(lines.find((line) => line.includes('"res":'))!) as Record<string, any>;
  }

  for (const statusCode of [400, 503]) {
    it(`emits no sender value anywhere in the ${statusCode} line`, async () => {
      const { logger, lines } = captureLogger();

      await request(buildApp(logger, statusCode))
        .post(`/api/plugins/slack/webhooks/slack-events?companyId=c1&token=${QUERY_SENTINEL}`)
        .send(slackBody)
        .expect(statusCode);

      const entry = await httpLine(lines);
      const emitted = lines.join("");
      expect(emitted).not.toContain(SENTINEL);
      expect(emitted).not.toContain(QUERY_SENTINEL);

      expect(entry.reqBody).toBe("[OMITTED: untrusted webhook payload]");
      expect(entry.reqBodyKeys).toEqual(["event", "team_id", "token", "type"]);
      expect(entry.reqQuery).toBe("[OMITTED: untrusted webhook query]");
      expect(entry.reqQueryKeys).toEqual(["companyId", "token"]);
      expect(entry.reqParams).toEqual({ pluginId: "slack", endpointKey: "slack-events" });
      // The message and pino-http's own serialized `req` carry the URL too;
      // both must drop the query string, and the message is the
      // mount-relative form the field evidence on BLO-29716 showed.
      expect(entry.msg).toMatch(new RegExp(`^POST /plugins/slack/webhooks/slack-events ${statusCode}`));
      expect(entry.req.url).toBe("/api/plugins/slack/webhooks/slack-events");
      expect(entry.req.query).toBe("[OMITTED: untrusted webhook query]");
    });
  }

  it("leaves non-webhook routes logging their query and redacted body", async () => {
    const { logger, lines } = captureLogger();

    await request(buildApp(logger, 503))
      .post("/api/issues?cursor=abc")
      .send({ title: "x", password: "hunter2" })
      .expect(400);

    const entry = await httpLine(lines);
    // Untouched route: the message keeps its query string as before.
    expect(entry.msg).toBe("POST /issues?cursor=abc 400");
    expect(entry.req.url).toBe("/api/issues?cursor=abc");
    expect(entry.reqQuery).toEqual({ cursor: "abc" });
    expect(entry.reqBody).toEqual({ title: "x", password: "[REDACTED]" });
  });
});
