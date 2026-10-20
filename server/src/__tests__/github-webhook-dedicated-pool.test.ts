/**
 * BLO-47034 — the API tier's GitHub webhook router runs on its own pool.
 *
 * The #2780 bulkhead bounded deliveries, yet after it shipped the API pool
 * still flashed to 18/18 active with 150-175 queries waiting during webhook
 * bursts, and nothing could attribute the holders. A pool boundary holds no
 * matter which caller it is, and is carved out of POSTGRES_POOL_MAX so the
 * connection budget (doc/DATABASE-CONNECTION-BUDGET.md) is unchanged.
 *
 * Structural assertions over the wiring, in the style of
 * metrics-route-no-db.test.ts: the failure this guards is the router quietly
 * receiving the shared `db` again, which no unit test of the router can see.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const APP_SOURCE = read("../app.ts");
const INDEX_SOURCE = read("../index.ts");

describe("dedicated GitHub webhook pool wiring (BLO-47034)", () => {
  it("mounts the webhook router on the dedicated pool and sizes its bounds from it", () => {
    expect(APP_SOURCE).toContain("githubWebhookRoutes(opts.githubWebhookDb ?? db, {");
    expect(APP_SOURCE).toContain(
      "poolMax: opts.githubWebhookDb ? POSTGRES_WEBHOOK_POOL_MAX : POSTGRES_POOL_MAX,",
    );
    expect(APP_SOURCE).toContain("dedicatedPool: Boolean(opts.githubWebhookDb),");
  });

  it("publishes the webhook pool's gauges beside the main pool's", () => {
    expect(APP_SOURCE).toContain('refreshDbPoolMetrics(db, "main");');
    expect(APP_SOURCE).toContain(
      'if (opts.githubWebhookDb) refreshDbPoolMetrics(opts.githubWebhookDb, "webhook");',
    );
  });

  it("splits only on the API tier, and carves the webhook pool out of the main one", () => {
    expect(INDEX_SOURCE).toContain('const splitWebhookPool = config.paperclipNodeRole === "api";');
    expect(INDEX_SOURCE).toContain(
      "splitWebhookPool ? POSTGRES_POOL_MAX - POSTGRES_WEBHOOK_POOL_MAX : POSTGRES_POOL_MAX,",
    );
    expect(INDEX_SOURCE).toContain("createDb(config.databaseUrl, POSTGRES_WEBHOOK_POOL_MAX)");
    expect(INDEX_SOURCE).toContain("githubWebhookDb: githubWebhookDb as any,");
  });
});
