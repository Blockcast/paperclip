/**
 * BLO-33243 — DB pool occupancy must be observable.
 *
 * There was no pool instrumentation anywhere in this fleet, which is why the
 * `/metrics` scrape timeouts could be measured precisely (82 and 72 lost
 * samples over 9 h, every one a 10 s timeout, statistically independent across
 * pods and across nodes — the signature of a per-process pool) and still not
 * be *attributed*: nothing exported the pool, so the leading explanation stayed
 * an inference. These gauges close that.
 *
 * postgres.js exposes no pool statistics of its own; `poolStats()` is added by
 * `patches/postgres@3.4.9.patch`. The first test is therefore the guard that
 * the patch survives a dependency bump — without it, a lost patch degrades to
 * "the gauges quietly stop moving", which is the same class of silent
 * blindness this issue is about.
 */

import { createDb } from "@paperclipai/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  DB_POOL_CONNECTIONS_METRIC,
  DB_POOL_WAITING_QUERIES_METRIC,
  __resetMetricsForTest,
  renderMetrics,
} from "../services/metrics.js";
import { refreshDbPoolMetrics } from "../services/scrape-metrics-collector.js";

// postgres.js connects lazily, so this opens no socket.
const IDLE_URL = "postgres://unused:unused@127.0.0.1:1/unused";

afterEach(() => {
  __resetMetricsForTest();
});

async function seriesFor(metric: string): Promise<string[]> {
  const { body } = await renderMetrics();
  return body
    .split("\n")
    .filter((line) => line.startsWith(`${metric}{`) || line.startsWith(`${metric} `));
}

describe("DB pool exposition (BLO-33243)", () => {
  it("still finds poolStats() on the patched postgres.js client", () => {
    const db = createDb(IDLE_URL) as unknown as { $client: { poolStats?: () => unknown } };
    expect(
      typeof db.$client.poolStats,
      "patches/postgres@3.4.9.patch no longer applies — pool gauges would silently stop",
    ).toBe("function");
    expect(db.$client.poolStats?.()).toMatchObject({
      max: expect.any(Number),
      idle: expect.any(Number),
      active: expect.any(Number),
      connecting: expect.any(Number),
      waiting: expect.any(Number),
    });
  });

  it("publishes every pool state as a real series", async () => {
    refreshDbPoolMetrics(createDb(IDLE_URL) as never);

    const states = (await seriesFor(DB_POOL_CONNECTIONS_METRIC)).map(
      (line) => line.match(/state="([^"]+)"/)?.[1],
    );
    expect(states.sort()).toEqual(["active", "connecting", "idle", "max"]);
    expect(await seriesFor(DB_POOL_WAITING_QUERIES_METRIC)).toHaveLength(1);
  });

  it("degrades to no-op rather than throwing when the client has no poolStats", () => {
    expect(() => refreshDbPoolMetrics({ $client: {} } as never)).not.toThrow();
    expect(() => refreshDbPoolMetrics({} as never)).not.toThrow();
  });
});
