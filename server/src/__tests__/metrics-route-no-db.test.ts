/**
 * BLO-33243 — `/metrics` must not touch the database.
 *
 * The handler used to await five DB-querying refreshes in strict series before
 * rendering, against a 10 s scrape timeout. A pool stall therefore did not
 * merely slow the scrape down, it failed it — and a failed scrape ingests no
 * sample at all, so the entire in-process metric set for that interval was
 * destroyed, including the event-loop-lag gauge an investigator reaches for
 * first. Two of three control-plane pods were losing ~1 scrape in 8 that way.
 *
 * These are structural assertions over the route declaration in `app.ts`, in
 * the same style as the route tests added for BLO-32164. They are deliberately
 * NOT "render `/metrics` and check it is fast": the regression this guards
 * against only shows up under pool contention, which a green test run does not
 * have, so a timing assertion would pass on exactly the code being rejected.
 * What can be pinned without contention is the shape — nothing awaited on the
 * request path except the registry render.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_SOURCE = readFileSync(fileURLToPath(new URL("../app.ts", import.meta.url)), "utf8");

/** The five DB-querying refreshes that used to run inline before every render. */
const DB_REFRESHES = [
  "refreshExternalRuntimeReservationMetrics",
  "refreshQueuedRunAgeMetrics",
  "refreshOverdueScheduledRetryAgeMetrics",
  "refreshScheduledRetryParkHorizonMetrics",
  "refreshExternalRuntimeReservationStrandMetrics",
];

/** Extract a route handler body by brace-matching from its `app.get(...)` declaration. */
function routeHandlerSource(path: string): string {
  const start = APP_SOURCE.indexOf(`app.get("${path}"`);
  expect(start, `no app.get("${path}") declaration found`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < APP_SOURCE.length; i += 1) {
    const ch = APP_SOURCE[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return APP_SOURCE.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated app.get("${path}") declaration`);
}

describe("/metrics request path (BLO-33243)", () => {
  const handler = routeHandlerSource("/metrics");

  it("awaits nothing but the registry render", () => {
    const awaited = [...handler.matchAll(/await\s+([A-Za-z0-9_.]+)/g)].map((m) => m[1]);
    expect(awaited).toEqual(["renderMetrics"]);
  });

  it("invokes none of the DB-querying refreshes", () => {
    for (const refresh of DB_REFRESHES) {
      expect(handler, `${refresh} must not run on the scrape path`).not.toContain(refresh);
    }
  });

  it("does not import the DB-querying refreshes into app.ts at all", () => {
    // Not redundant with the handler check: an import left behind is how the
    // inline calls would come back, and it is the cheapest thing to notice.
    for (const refresh of DB_REFRESHES) {
      expect(APP_SOURCE, `${refresh} should live in the collector, not app.ts`).not.toContain(
        refresh,
      );
    }
  });

  it("starts the background collector that owns those refreshes instead", () => {
    // Every tier serves /metrics and is a scrape target, so unlike the plugin
    // status collector this one must not sit inside the node-role branch —
    // pinned by its indentation, which is what a nested start would change.
    expect(APP_SOURCE).toContain("\n  const stopScrapeMetricsCollector = startScrapeMetricsCollector(db);\n");
    expect(APP_SOURCE).toContain("stopScrapeMetricsCollector();");
  });
});
