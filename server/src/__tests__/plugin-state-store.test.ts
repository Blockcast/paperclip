import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, pluginState, plugins } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pluginStateStore } from "../services/plugin-state-store.js";
import { GBRAIN_RECALL_METRIC, __resetMetricsForTest, renderMetrics } from "../services/metrics.js";
// Imported from the gbrain plugin's real producer on purpose (BLO-25892). The
// server-side extractor in plugin-state-store.ts duck-types `value.status` out
// of a payload owned by packCacheEntry, and nothing in server/ imports
// StoredRecall, so there is no type-level link between the two packages. If
// this fixture were hand-built and the producer ever moved `status` under an
// envelope key, normalizeGbrainRecallStatus would send every real prefetch to
// "other", status="error" would stay flat at 0, and the alert would never fire
// — indistinguishable from a healthy fleet, with both tests still green.
// Building the fixture from the producer makes a producer-side rename break
// this test instead of silently zeroing the detector. Same relative
// cross-package import pattern as linear-webhook-fixture-replay.test.ts.
import {
  buildCacheEntry,
  packCacheEntry,
} from "../../../packages/plugins/paperclip-plugin-gbrain/src/recall.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin-state-store tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("plugin state store", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let pluginId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-state-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await db.delete(pluginState);
    await db.delete(plugins);

    pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `paperclip.state-test.${pluginId}`,
      packageName: "@paperclipai/state-test",
      version: "1.0.0",
      manifestJson: {} as never,
    });
  });

  it("treats stateKeyPrefix wildcard characters literally", async () => {
    const store = pluginStateStore(db);
    const keys = [
      "literal:%:match",
      "literal:X:match",
      "literal:_:match",
      "literal:A:match",
      "literal:\\:match",
      "literal::match",
    ];

    for (const stateKey of keys) {
      await store.set(pluginId, {
        scopeKind: "instance",
        stateKey,
        value: { stateKey },
      });
    }

    await expectKeysForPrefix("literal:%", ["literal:%:match"]);
    await expectKeysForPrefix("literal:_", ["literal:_:match"]);
    await expectKeysForPrefix("literal:\\", ["literal:\\:match"]);

    async function expectKeysForPrefix(prefix: string, expected: string[]) {
      const result = await store.list(pluginId, {
        scopeKind: "instance",
        stateKeyPrefix: prefix,
        limit: 10,
      });

      expect(result.rows.map((row) => row.stateKey)).toEqual(expected);
      expect(result.hasMore).toBe(false);
    }
  });

  it("increments the gbrain recall metric on a run-scoped gbrain-context write, and not on other writes (BLO-25892)", async () => {
    __resetMetricsForTest();
    const store = pluginStateStore(db);

    // Built by the real producer, not hand-written: this is the cross-package
    // shape contract the metric depends on. ok:false + a non-null
    // issuePageSlug + no "no-oauth-client" reasonKind is the branch that
    // yields status "error" — the 2026-08-08 outage's classification.
    const erroredRecall = packCacheEntry(
      buildCacheEntry({
        result: {
          ok: false,
          issuePageSlug: "issues/blo-25892",
          graph: null,
          reason: "traverse_graph failed: fetch failed",
        },
        depth: 2,
        nowIso: "2026-08-08T11:00:00.000Z",
      }),
    );
    // Guard the guard: if the producer stops emitting a top-level "error"
    // status, fail here with a clear message rather than further down as a
    // confusing zero counter.
    expect(erroredRecall.status).toBe("error");

    await store.set(pluginId, {
      scopeKind: "run",
      scopeId: randomUUID(),
      stateKey: "gbrain-context",
      value: erroredRecall,
    });
    await store.set(pluginId, {
      scopeKind: "instance",
      stateKey: "gbrain-context",
      value: erroredRecall,
    });
    await store.set(pluginId, {
      scopeKind: "run",
      scopeId: randomUUID(),
      stateKey: "some-other-state-key",
      value: erroredRecall,
    });

    const { body } = await renderMetrics();
    expect(body).toContain(`${GBRAIN_RECALL_METRIC}{status="error"} 1`);
    expect(body).not.toMatch(new RegExp(`${GBRAIN_RECALL_METRIC}\\{status="other"\\} [1-9]`));
  });
});
