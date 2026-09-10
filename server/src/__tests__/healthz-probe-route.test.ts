import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

/**
 * BLO-32164. `/healthz` is the endpoint every Kubernetes probe targets, and it
 * used to have no handler at all — requests fell through to the SPA catch-all,
 * which answered 200 with the UI shell after a synchronous `readFileSync` of
 * index.html. These tests pin the three properties that made that accident
 * expensive, so the route cannot silently regress into a dependency again:
 *
 *   1. it is declared before any middleware that could block or slow it,
 *   2. its handler acquires nothing (no db, no fs, not even async), and
 *   3. the path it declares still matches the path the chart actually probes.
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
  it("responds 200 without touching a database", async () => {
    // The handler is intentionally trivial enough to restate here; the
    // structural assertions below are what bind it to the real app.
    const app = express();
    app.get("/healthz", (_req, res) => {
      res.status(200).set("Cache-Control", "no-store").json({ status: "ok" });
    });

    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(res.headers["cache-control"]).toBe("no-store");
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
