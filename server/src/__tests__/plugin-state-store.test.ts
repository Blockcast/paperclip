import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, pluginState, plugins } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { STATE_PRECONDITION_FAILED_CODE, pluginStateStore } from "../services/plugin-state-store.js";
import { GBRAIN_RECALL_METRIC, __resetMetricsForTest, renderMetrics } from "../services/metrics.js";
// Imported from the gbrain plugin's real producer on purpose (BLO-25892). The
// server-side extractor in plugin-state-store.ts duck-types `value.status` out
// of a payload owned by packCacheEntry, and matches on a private literal copy
// of the state key; nothing in server/ imports StoredRecall or
// RECALL_STATE_KEY, so there is no type-level link between the two packages.
// Both halves of that contract are bound here rather than hand-written:
//
//   - payload shape: if the producer moved `status` under an envelope key,
//     normalizeGbrainRecallStatus would send every real prefetch to "other".
//   - state key: if RECALL_STATE_KEY's value changed, the plugin would keep
//     working (its write and read move together) while the server's matcher
//     silently stopped matching.
//
// Either drift zeroes status="error" and the alert never fires —
// indistinguishable from a healthy fleet, with both tests still green. The
// state-key leg is the more silent of the two: `status` has an independent
// brake in the value_json->>'status' partial indexes and the RAG-health route,
// whereas nothing on the server notices a state-key rename except this counter.
// Same relative cross-package import pattern as
// linear-webhook-fixture-replay.test.ts.
import {
  RECALL_STATE_KEY,
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

  /**
   * BLO-20650 — `expectedValue` turns the upsert into a compare-and-swap, so a
   * speculative reader (the alertmanager escalation sweep) cannot write a
   * stale record back over a concurrent authoritative write (an inbound
   * resolve webhook). Exercised against real Postgres because the guard is a
   * `jsonb` equality in the statement's own `WHERE`, and nothing above this
   * layer can tell a comparison that is wrong from one that never ran.
   */
  const casRef = { scopeKind: "company" as const, scopeId: "company-1", stateKey: "alert:fp-1" };
  const readCas = (store: ReturnType<typeof pluginStateStore>, stateKey = casRef.stateKey) =>
    store.get(pluginId, casRef.scopeKind, stateKey, { scopeId: casRef.scopeId });

  it("applies an ifMatch write only while the stored value is unchanged (BLO-20650)", async () => {
    const store = pluginStateStore(db);
    const initial = { resolvedAt: null, escalationAttempt: 0, alertname: "SyntheticAlert" };
    await store.set(pluginId, { ...casRef, value: initial });

    // Swap against a current read lands.
    await store.set(pluginId, { ...casRef, value: { ...initial, escalationAttempt: 1 } }, null, initial);
    expect(await readCas(store)).toEqual({ ...initial, escalationAttempt: 1 });

    // A second writer still holding the now-stale read is refused and changes
    // nothing. This is the concurrent-webhook case the sweep has to lose.
    await expect(
      store.set(pluginId, { ...casRef, value: { ...initial, escalationAttempt: 2 } }, null, initial),
    ).rejects.toMatchObject({ details: { code: STATE_PRECONDITION_FAILED_CODE } });
    expect(await readCas(store)).toEqual({ ...initial, escalationAttempt: 1 });
  });

  it("compares ifMatch structurally, and refuses a missing row (BLO-20650)", async () => {
    const store = pluginStateStore(db);
    await store.set(pluginId, { ...casRef, value: { a: 1, b: { c: 2 } } });

    // jsonb `=` compares the normalized document, so a differently-ordered but
    // equal object still matches. That matters because the caller's `ifMatch`
    // has been through a JSON round-trip over the worker RPC and it does not
    // control key order.
    await store.set(pluginId, { ...casRef, value: { ok: true } }, null, { b: { c: 2 }, a: 1 });
    expect(await readCas(store)).toEqual({ ok: true });

    // No row at all: the value the caller read is gone, so writing it back
    // would be a lost update. Refuse rather than silently resurrect it — an
    // `onConflictDoUpdate ... setWhere` would have INSERTed here.
    await expect(
      store.set(pluginId, { ...casRef, stateKey: "alert:absent", value: { x: 1 } }, null, { x: 0 }),
    ).rejects.toMatchObject({ details: { code: STATE_PRECONDITION_FAILED_CODE } });
    expect(await readCas(store, "alert:absent")).toBeNull();
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
      stateKey: RECALL_STATE_KEY,
      value: erroredRecall,
    });
    // Scope-filter negative: the *real* recall key under the wrong scope. Bound
    // to the constant so a rename keeps this case exercising the scope filter
    // against the live key instead of degrading into a second stale-key case.
    await store.set(pluginId, {
      scopeKind: "instance",
      stateKey: RECALL_STATE_KEY,
      value: erroredRecall,
    });
    // Key-filter negative: deliberately a literal, since it must stay a
    // non-matching key no matter what RECALL_STATE_KEY becomes.
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
