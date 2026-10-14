import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { HEALTH_PROBE_DEADLINE_MS } from "../routes/health.js";

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

  it("serves /livez through the real stack, and ahead of the hostname guard", async () => {
    // BLO-40591. The unit tests in api-pipeline-liveness.test.ts cover the
    // detector; this covers the wiring — that the route is mounted at all, and
    // mounted early enough that a probe cannot be failed by the `Host:`
    // allowlist. A healthy app must answer 200: a liveness route that 503s a
    // quiet instance restarts the singleton worker for no reason.
    const probe = await request(app).get("/livez").set("Host", "not-allowlisted.example");

    expect(probe.status).toBe(200);
    expect(probe.body?.status).toBe("ok");
    expect(probe.body?.wedged).toBe(false);
    expect(probe.headers["cache-control"]).toBe("no-store");
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
    //
    // BLO-35948 widened this from "every probe is /healthz" to "every probe is
    // one of the routes the server actually declares". Worker readiness
    // targets `/api/health` so a dead connection pool takes the pod NotReady;
    // BLO-40591 moved worker liveness to `/livez`, which is dependency-free
    // like `/healthz` but can report an API pipeline that accepts requests and
    // answers none. Startup stays on `/healthz`. Which probe gets which path
    // is asserted against the *rendered* chart in
    // `deploy/helm/paperclip/tests/probes.test.mjs`, where the probe blocks
    // are parsed individually — this test only pins that no probe points at a
    // path nothing serves.
    expect(probePaths.length).toBeGreaterThanOrEqual(6);
    expect([...new Set(probePaths)].sort()).toEqual([
      "/api/health",
      "/healthz",
      "/livez",
    ]);
  });
});

/**
 * BLO-28615. `/api/health` is now the readiness probe path on BOTH tiers — the
 * worker since BLO-35948, the API Deployment since this issue. The tests above
 * cover the two dependency-free probe routes; these cover the one that is
 * deliberately NOT dependency-free, through the real `createApp` stack rather
 * than against a router mounted on a bare Express app.
 *
 * That distinction is the whole point of putting them here. `health.test.ts`
 * mounts `healthRoutes` directly, so it can prove the handler's logic but not
 * that a probe reaching this path is answered by the handler at all — which is
 * exactly the class of defect BLO-32164 was: a probe path resolving through the
 * SPA catch-all and reporting 200/text/html for a process that attested
 * nothing.
 */
describe("/api/health as a readiness probe path", () => {
  let app: Express;
  // Separate boot from the suite above, which deliberately passes a bare `{}`
  // db so that any dependency creeping onto `/healthz` or `/livez` throws
  // loudly. Giving that app a working `execute` would silence that control, so
  // the readiness path gets its own instance instead.
  //
  // Seeded healthy at declaration rather than in a test: `createApp` runs
  // before the first `it`, and a bare `vi.fn()` would hand boot-time callers
  // `undefined`.
  const execute = vi.fn().mockResolvedValue([{ "?column?": 1 }]);

  beforeAll(async () => {
    app = await createApp({ execute } as never, {
      uiMode: "none",
      serverPort: 0,
      storageService: {} as never,
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

  it("answers 2xx as JSON — not the catch-all's text/html — when the pool is reachable", async () => {
    execute.mockResolvedValue([{ "?column?": 1 }]);

    const res = await request(app).get("/api/health").set("Host", "127.0.0.1:3100");

    expect(res.status).toBe(200);
    expect(res.body?.status).toBe("ok");
    // The content-type assertion is the one that pins the catch-all
    // specifically: that regression was also a 200, and differed only in
    // answering `text/html` with the UI shell. A status check alone would not
    // have caught it.
    expect(res.headers["content-type"]).toMatch(/^application\/json\b/);
    expect(res.headers["content-type"]).not.toMatch(/text\/html/);
    // Control: the probe's verdict came from the pool, not from a route that
    // happens to answer 200 regardless. Without this the test passes just as
    // happily against an endpoint that never queries anything.
    expect(execute).toHaveBeenCalled();
  });

  it("answers 503 when the pool is unreachable, so the pod leaves the Service", async () => {
    execute.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const res = await request(app).get("/api/health").set("Host", "127.0.0.1:3100");

    // Non-2xx is the entire point: on `/healthz` this same failure answered
    // 200 and the replica stayed in the endpoint list serving traffic it could
    // not fulfil.
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "unhealthy", error: "database_unreachable" });
    expect(res.headers["content-type"]).toMatch(/^application\/json\b/);
  });

  it("answers 503 inside the probe timeout when the pool hangs rather than refusing", async () => {
    // The *dead*-pool case, which is not the one above. `connect_timeout` is
    // the driver's 30s default and the role `statement_timeout` is 30s, both
    // longer than the 20s readiness timeout the chart pins — so without a
    // bound the probe is abandoned by kubelet rather than answered. An
    // abandoned response is not a completion (`res.writableFinished` is
    // false), so it never refreshes the `/livez` wedge detector's clock, and
    // once readiness has drained the endpoints the probe is the only /api
    // traffic left: the detector reaches API_PIPELINE_STALL_MS and liveness
    // restarts every replica, repeatedly, for the length of the outage.
    //
    // What this pins is that the handler *completes*. The verdict is the same
    // 503 either way; the difference is whether anything answers at all.
    expect(HEALTH_PROBE_DEADLINE_MS).toBeLessThan(20_000);
    // And above the 13.19s saturation tail: below it, a slow-but-alive pool
    // 503s and readiness drains every replica together.
    expect(HEALTH_PROBE_DEADLINE_MS).toBeGreaterThan(13_190);

    let enteredHandler: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enteredHandler = resolve;
    });
    execute.mockImplementation(() => {
      enteredHandler();
      // Never settles: a pool with no reachable server, before the driver's
      // own 30s connect timeout fires.
      return new Promise(() => {});
    });

    // Only the two timer functions the deadline itself uses. Faking the full
    // set takes `nextTick`/`setImmediate` with it, which the http server the
    // request is travelling over needs to make progress.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = request(app).get("/api/health").set("Host", "127.0.0.1:3100");
      const responded = pending.then((res) => res);
      // Advance only once the handler has registered its deadline, otherwise
      // there is no timer to advance and the request hangs forever.
      await entered;
      await vi.advanceTimersByTimeAsync(HEALTH_PROBE_DEADLINE_MS + 1);

      const res = await responded;
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ status: "unhealthy", error: "database_unreachable" });
    } finally {
      vi.useRealTimers();
      execute.mockReset();
      execute.mockResolvedValue([{ "?column?": 1 }]);
    }
  });

  it("cannot be impersonated by an undeclared /api path falling through to the SPA", async () => {
    execute.mockResolvedValue([{ "?column?": 1 }]);

    // `app.use("/api", …)` terminates every unmatched /api request with a JSON
    // 404 before the SPA catch-all is reached, so moving the probe under /api
    // does not move the BLO-32164 problem to a new path: a typo'd or retired
    // probe path fails loudly instead of inheriting a 200 from the UI shell.
    const res = await request(app)
      .get("/api/health/ready")
      .set("Host", "127.0.0.1:3100");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/json\b/);
    // toMatchObject, not toEqual: the response carries a `publicUrl` field
    // added downstream of this handler. What matters here is the shape a probe
    // would see — a JSON error, not the UI shell.
    expect(res.body).toMatchObject({ error: "API route not found" });
  });

  it("declares the /api 404 terminator ahead of the SPA catch-all", () => {
    // The live assertion above runs with `uiMode: "none"`, where no catch-all
    // is mounted at all — so on its own it cannot distinguish "the terminator
    // answered" from "nothing else was there to answer". This pins the
    // ordering that makes it true in a UI-serving build too.
    expect(indexOfOrFail(appSource, 'app.use("/api", (_req, res) => {')).toBeLessThan(
      indexOfOrFail(appSource, "app.get(/.*/"),
    );
  });
});
