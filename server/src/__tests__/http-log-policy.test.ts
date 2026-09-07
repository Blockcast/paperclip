import { describe, expect, it } from "vitest";
import { buildHttpLogProps, shouldOmitRequestBodyFromLog, shouldSilenceHttpSuccessLog } from "../middleware/http-log-policy.js";

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

describe("buildHttpLogProps — no credential reaches a rejection log line", () => {
  const SENTINEL = "xoxb-sentinel-verification-token-do-not-log";
  const slackBody = {
    token: SENTINEL,
    type: "event_callback",
    team_id: "T123",
    event: { type: "message", text: "hi" },
  };

  // Both statuses are exercised because customProps keys on `>= 400`, not on
  // 4xx. BLO-28659 moved the readiness guard from 400 to 503; if the guarantee
  // were coupled to one status code that change would have silently
  // reintroduced the leak. It must hold on whichever code the guard returns.
  for (const statusCode of [400, 503]) {
    it(`omits the Slack verification token on a ${statusCode} rejection`, () => {
      const props = buildHttpLogProps(
        { url: "/plugins/slack/webhooks/slack-events", body: slackBody },
        { statusCode },
      );

      expect(JSON.stringify(props)).not.toContain(SENTINEL);
      expect(props.reqBody).toBe("[OMITTED: untrusted webhook payload]");
    });

    it(`omits it on the ${statusCode} error-handler path as well`, () => {
      // The error handler stashes its own copy on res.__errorContext; that is
      // a second branch and needs the same guard.
      const props = buildHttpLogProps(
        { url: "/plugins/slack/webhooks/slack-events" },
        { statusCode, __errorContext: { error: { message: "boom" }, reqBody: slackBody } },
      );

      expect(JSON.stringify(props)).not.toContain(SENTINEL);
      expect(props.reqBody).toBe("[OMITTED: untrusted webhook payload]");
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
      { url: "/plugins/slack/webhooks/slack-events", body: slackBody },
      { statusCode: 503 },
    );

    expect(props.reqBodyKeys).toEqual(["event", "team_id", "token", "type"]);
    expect(props.reqBodyBytes).toBe(Buffer.byteLength(JSON.stringify(slackBody), "utf8"));
  });

  it("still logs and redacts bodies on non-webhook routes", () => {
    const props = buildHttpLogProps(
      { url: "/api/auth/sign-in/email", body: { email: "a@b.co", password: "hunter2" } },
      { statusCode: 400 },
    );

    expect(props.reqBody).toEqual({ email: "a@b.co", password: "[REDACTED]" });
  });

  it("logs nothing extra for a successful response", () => {
    expect(buildHttpLogProps({ url: "/plugins/slack/webhooks/slack-events", body: slackBody }, { statusCode: 200 })).toEqual({});
  });
});
