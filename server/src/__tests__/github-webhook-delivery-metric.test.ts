/**
 * BLO-39378: the DELIVERY counter.
 *
 * `paperclip_github_workflow_run_conclusion_total` counts only what a healthy
 * webhook delivered, so the failure shape where the api is up but GitHub stops
 * delivering — secret rotated, hook disabled, endpoint 404ing, GitHub-side
 * incident — emits a flat series byte-identical to a genuinely quiet CI window.
 * This counter is the denominator that shape needs: it is incremented at the
 * receiver on every inbound delivery, so its own flatline is the fault.
 *
 * These tests pin the four properties an alert on it would depend on:
 *   1. the 0 -> 1 transition happens for an accepted delivery;
 *   2. a signature rejection is counted, and counted DISTINGUISHABLY — a
 *      rotated secret presents as healthy delivery volume with nothing
 *      accepted, which a success-only counter cannot see;
 *   3. the series is zero-initialised, so `sum(increase(...)) == 0` evaluates
 *      rather than returning an empty vector (which would read as "no alert");
 *   4. the attacker-controlled `x-github-event` header cannot mint a series —
 *      the increment happens before the signature is verified, so an unbounded
 *      label here would be a remote cardinality bomb.
 */
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GITHUB_WEBHOOK_DELIVERY_METRIC,
  KNOWN_GITHUB_WEBHOOK_EVENTS,
  KNOWN_GITHUB_WEBHOOK_OUTCOMES,
  UNKNOWN_GITHUB_WEBHOOK_EVENT,
  __resetMetricsForTest,
  normalizeGithubWebhookEvent,
  renderMetrics,
} from "../services/metrics.js";
import { WAKE_DRIVING_EVENTS, githubWebhookRoutes } from "../routes/github-webhook.js";
import type { Db } from "../db.js";

const WEBHOOK_SECRET = "test-webhook-secret";

// None of the paths exercised here reach the database: an unconfigured secret
// 503s, a bad signature 401s, and `ping` is not in the wake-driving set so it
// is ignored before any query. A throwing stub keeps that honest — if a future
// change routes one of these through the db, this test fails loudly rather
// than quietly needing a fixture.
const db = new Proxy({} as Db, {
  get(_t, prop) {
    throw new Error(`unexpected db access in a DB-free webhook path: ${String(prop)}`);
  },
});

function buildApp(secret: string | null) {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));
  app.use("/api/webhooks/github", githubWebhookRoutes(db, { webhookSecret: secret }));
  return app;
}

function sign(body: string): string {
  return "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET)
    .update(Buffer.from(body, "utf8")).digest("hex");
}

/** Read one counter series out of the rendered exposition, or null if absent. */
async function deliveryValue(event: string, outcome: string): Promise<number | null> {
  const { body } = await renderMetrics();
  for (const line of body.split("\n")) {
    if (!line.startsWith(GITHUB_WEBHOOK_DELIVERY_METRIC + "{")) continue;
    if (!line.includes(`event="${event}"`) || !line.includes(`outcome="${outcome}"`)) continue;
    return Number(line.slice(line.lastIndexOf("}") + 1).trim());
  }
  return null;
}

/** Every rendered series of this metric, as `event/outcome` pairs. */
async function deliveryLabelPairs(): Promise<string[]> {
  const { body } = await renderMetrics();
  return body.split("\n")
    .filter((l) => l.startsWith(GITHUB_WEBHOOK_DELIVERY_METRIC + "{"))
    .map((l) => {
      const event = /event="([^"]*)"/.exec(l)?.[1] ?? "?";
      const outcome = /outcome="([^"]*)"/.exec(l)?.[1] ?? "?";
      return `${event}/${outcome}`;
    });
}

describe("paperclip_github_webhook_delivery_total", () => {
  beforeEach(() => {
    __resetMetricsForTest();
  });

  it("is zero-initialised, so `== 0` evaluates instead of returning an empty vector", async () => {
    // This is the property that makes the shape-B alert expressible at all. An
    // absent series makes `sum(increase(...)) == 0` return empty, which reads
    // as "nothing to alert on" — the exact false-green this metric exists to
    // remove. It is also why an `absent()` arm on THIS metric would be inert;
    // see BLO-39160, which settled that for the sibling counter.
    expect(await deliveryValue("workflow_run", "accepted")).toBe(0);
    expect(await deliveryValue("workflow_run", "rejected_signature")).toBe(0);

    const expected = (KNOWN_GITHUB_WEBHOOK_EVENTS.length + 1) * KNOWN_GITHUB_WEBHOOK_OUTCOMES.length;
    expect(await deliveryLabelPairs()).toHaveLength(expected);
  });

  it("counts an accepted delivery 0 -> 1", async () => {
    const body = JSON.stringify({ zen: "Design for failure." });
    const res = await request(buildApp(WEBHOOK_SECRET))
      .post("/api/webhooks/github")
      .set("x-github-event", "ping")
      .set("x-hub-signature-256", sign(body))
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBeLessThan(400);
    expect(await deliveryValue("ping", "accepted")).toBe(1);
    expect(await deliveryValue("ping", "rejected_signature")).toBe(0);
  });

  it("counts a signature rejection separately from an accepted delivery", async () => {
    const body = JSON.stringify({ action: "completed" });
    const res = await request(buildApp(WEBHOOK_SECRET))
      .post("/api/webhooks/github")
      .set("x-github-event", "workflow_run")
      .set("x-hub-signature-256", "sha256=" + "0".repeat(64))
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(401);
    // The load-bearing assertion: a rotated secret must NOT read as silence.
    expect(await deliveryValue("workflow_run", "rejected_signature")).toBe(1);
    expect(await deliveryValue("workflow_run", "accepted")).toBe(0);
  });

  it("counts a delivery the receiver could not accept at all as `error`", async () => {
    const body = JSON.stringify({ zen: "Anything added dilutes everything else." });
    const res = await request(buildApp(null))
      .post("/api/webhooks/github")
      .set("x-github-event", "ping")
      .set("x-hub-signature-256", sign(body))
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(503);
    expect(await deliveryValue("ping", "error")).toBe(1);
    expect(await deliveryValue("ping", "accepted")).toBe(0);
  });

  // Two of the forgeries that most motivate this guard cannot be tested over
  // HTTP at all: Node's client refuses to transmit them. `setHeader` throws
  // ERR_INVALID_CHAR against `headerCharRegex = /[^\t\x20-\x7e\x80-\xff]/`,
  // so a multi-byte value and a bare-newline header-injection value both
  // reject before the request is sent. Asserting the normalizer directly is
  // the stronger test anyway — a reverse proxy, or any future non-HTTP
  // caller, can still hand us those exact bytes.
  it("normalizes a forged event to `other`, including values HTTP cannot carry", () => {
    for (const forged of ["🐫".repeat(50), "workflow_run\nevil", "", "\u0000", "WORKFLOW_RUN"]) {
      expect(normalizeGithubWebhookEvent(forged)).toBe(UNKNOWN_GITHUB_WEBHOOK_EVENT);
    }
    expect(normalizeGithubWebhookEvent(undefined)).toBe(UNKNOWN_GITHUB_WEBHOOK_EVENT);
    expect(normalizeGithubWebhookEvent(null)).toBe(UNKNOWN_GITHUB_WEBHOOK_EVENT);
    // Positive control: without this, a normalizer that returned `other`
    // unconditionally would satisfy every assertion above.
    expect(normalizeGithubWebhookEvent("workflow_run")).toBe("workflow_run");
  });

  it("buckets a transmissible unrecognised x-github-event into `other` and mints no new series", async () => {
    // The increment runs BEFORE signature verification, so this header is
    // unauthenticated attacker input. Unbounded, it is a remote cardinality
    // bomb against the whole registry. Only values Node will actually put on
    // the wire belong here; the rest are covered by the normalizer test above.
    const before = await deliveryLabelPairs();
    const body = JSON.stringify({});
    const forgeries = ["sponsorship", randomish()];

    for (const forged of forgeries) {
      await request(buildApp(WEBHOOK_SECRET))
        .post("/api/webhooks/github")
        .set("x-github-event", forged)
        .set("x-hub-signature-256", "sha256=" + "0".repeat(64))
        .set("content-type", "application/json")
        .send(body);
    }

    expect(await deliveryLabelPairs()).toEqual(before);
    expect(await deliveryValue("other", "rejected_signature")).toBe(forgeries.length);
  });

  // The allowlist is `WAKE_DRIVING_EVENTS` + `ping`, and nothing but this
  // test keeps it that way. Adding a wake-driving event without adding it to
  // the allowlist compiles and ships: the counter keeps working, and the new
  // event is silently bucketed into `other`, so per-event attribution for the
  // one event someone just cared about is the thing that breaks. The failure
  // is safe (no cardinality growth) and invisible, so it would outlive anyone
  // remembering the invariant. Set comparison, not length — equal counts with
  // a swapped member is exactly the drift being guarded against.
  it("keeps the metric allowlist in lockstep with the events the receiver wakes on", () => {
    expect(new Set(KNOWN_GITHUB_WEBHOOK_EVENTS)).toEqual(new Set([...WAKE_DRIVING_EVENTS, "ping"]));
    // Positive control: `ping` is in the allowlist and deliberately NOT a
    // wake-driving event, so a test that dropped the `"ping"` term would be
    // asserting a falsehood rather than a weaker truth.
    expect(WAKE_DRIVING_EVENTS.has("ping")).toBe(false);
    expect(KNOWN_GITHUB_WEBHOOK_EVENTS).toContain("ping");
  });
});

function randomish(): string {
  return "evt-" + crypto.randomBytes(8).toString("hex");
}
