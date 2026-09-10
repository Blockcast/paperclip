import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";

/**
 * BLO-32164. `/healthz` is the endpoint every Kubernetes probe targets, and it
 * used to have no handler at all — requests fell through to the SPA catch-all,
 * which answered 200 with the UI shell after a synchronous `readFileSync` of
 * index.html. These tests pin the properties that made that accident
 * expensive, so the route cannot silently regress into a dependency again:
 *
 *   0. it actually answers the probe contract when the real app is booted,
 *   1. it is declared before any middleware that could block or slow it,
 *   2. its handler acquires nothing (no db, no fs, not even async), and
 *   3. the path it declares still matches the path the chart actually probes.
 *
 * (0) runs against the real `createApp`; (1), (2) and (3) read `app.ts` as
 * text, because ordering and dependency-freedom are properties of the
 * declaration that a live request cannot observe once the app is assembled.
 *
 * (3) is the one that matters most: the original defect was not a bug in any
 * single file, it was code and chart disagreeing about a string.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const appSource = fs.readFileSync(path.join(repoRoot, "server/src/app.ts"), "utf-8");

function indexOfOrFail(haystack: string, needle: string): number {
  const at = haystack.indexOf(needle);
  expect(at, `expected to find ${needle} in server/src/app.ts`).toBeGreaterThan(-1);
  return at;
}

describe("/healthz probe route", () => {
  // Booted once: this is the real `createApp`, not a stand-in. An earlier
  // revision asserted the 200 against a miniature Express app declared inside
  // the test, which restated the handler rather than exercising it — it would
  // have passed just as happily with the production route deleted. `db` is a
  // bare stub because nothing on this path may touch it; if that ever stops
  // being true, these tests fail loudly, which is the point.
  let app: Express;

  beforeAll(async () => {
    app = await createApp({} as never, {
      uiMode: "none",
      serverPort: 0,
      storageService: {} as never,
      // Private + local_trusted is what turns the hostname guard ON, which the
      // reachability test below depends on.
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: false,
      companyDeletionEnabled: false,
    } as never);
  }, 120_000);

  afterAll(async () => {
    await (app?.locals?.paperclipShutdown as undefined | (() => Promise<void>))?.();
  });

  it("answers 200 with the probe contract through the real application stack", async () => {
    // Allowlisted Host, matching what the chart sends today, so this test
    // isolates one question — does the production route answer correctly —
    // rather than also depending on the guard-bypass tested below.
    const res = await request(app).get("/healthz").set("Host", "127.0.0.1:3100");

    expect(res.status).toBe(200);
    // Asserting the body and the header, not just the status, is what
    // distinguishes "the route answered" from "the SPA catch-all answered with
    // the UI shell" — the original BLO-32164 defect, which was also a 200.
    expect(res.body).toEqual({ status: "ok" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("answers before the private-hostname guard can reject the probe", async () => {
    // The chart currently sends `Host: 127.0.0.1:3100` to satisfy the
    // allowlist. Being mounted ahead of the guard is what makes that header
    // unnecessary, so probe success cannot depend on the chart and the
    // allowlist agreeing.
    const probe = await request(app).get("/healthz").set("Host", "not-allowlisted.example");

    expect(probe.status).toBe(200);
    expect(probe.body).toEqual({ status: "ok" });

    // Control. Without this the assertion above is vacuous: it would pass just
    // as well if the guard were disabled entirely rather than bypassed. Match
    // the guard's own message, because an unmatched or unauthenticated path
    // also answers 403 here — the status alone would not identify the guard.
    const blocked = await request(app).get("/api/health").set("Host", "not-allowlisted.example");

    expect(blocked.status).toBe(403);
    expect(blocked.body?.error).toContain("not-allowlisted.example");
    expect(blocked.body?.error).toContain("is not allowed for this Paperclip instance");

    // Second control: the same path with an allowlisted Host gets *past* the
    // guard and fails later, on the stubbed database. That pins the 403 above
    // to the hostname specifically rather than to a blanket rejection.
    const allowed = await request(app).get("/api/health").set("Host", "127.0.0.1:3100");

    expect(allowed.status).not.toBe(403);
  });

  it("is declared ahead of logging, the hostname guard and actor resolution", () => {
    const healthz = indexOfOrFail(appSource, 'app.get("/healthz"');

    // A probe must not be failable by request logging volume, by the
    // `Host:` allowlist, or by auth resolution.
    for (const later of ["app.use(httpLogger)", "privateHostnameGuard({", "actorMiddleware(db"]) {
      expect(
        healthz,
        `/healthz must be declared before ${later} so a probe cannot be blocked by it`,
      ).toBeLessThan(indexOfOrFail(appSource, later));
    }
  });

  it("is declared ahead of the SPA catch-all that used to absorb it", () => {
    expect(indexOfOrFail(appSource, 'app.get("/healthz"')).toBeLessThan(
      indexOfOrFail(appSource, "app.get(/.*/"),
    );
  });

  it("has a synchronous handler that acquires no dependencies", () => {
    const start = indexOfOrFail(appSource, 'app.get("/healthz"');
    // Fixed window rather than brace matching: the handler is a one-liner and
    // this stays readable if it grows slightly.
    const body = appSource.slice(start, start + 400);

    // No awaited work of any kind: an await here is how a liveness probe
    // inherits someone else's latency and starts killing healthy pods.
    expect(body).not.toContain("await");
    expect(body).not.toContain("async");
    // No database. `/api/health` is the route that may check the database;
    // measured 2026-09-10 it took 13.19s under pool saturation while
    // `/healthz` answered in 6ms, which is precisely why they stay separate.
    expect(body).not.toMatch(/\bdb\b/);
    expect(body).not.toContain("readFileSync");
  });

  it("matches the path every probe in the chart targets", () => {
    const values = fs.readFileSync(
      path.join(repoRoot, "deploy/helm/paperclip/values.yaml"),
      "utf-8",
    );

    // Only paths inside an `httpGet:` block are probe paths — values.yaml also
    // carries the ServiceMonitor's `path: /metrics`, which is not a probe.
    const lines = values.split("\n");
    const probePaths: string[] = [];
    let inHttpGet = false;
    for (const line of lines) {
      if (/^\s*httpGet:\s*$/.test(line)) {
        inHttpGet = true;
        continue;
      }
      const match = inHttpGet ? /^\s*path:\s*(\S+)\s*$/.exec(line) : null;
      if (match) {
        probePaths.push(match[1]);
        inHttpGet = false;
      }
    }

    // Guards the code<->chart disagreement that caused BLO-32164: if a probe
    // path is ever changed in the chart, this fails instead of silently
    // routing probes back into the SPA catch-all.
    expect(probePaths.length).toBeGreaterThanOrEqual(6);
    expect([...new Set(probePaths)]).toEqual(["/healthz"]);
  });
});
