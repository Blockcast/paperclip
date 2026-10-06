/**
 * BLO-33168 — a replayed delivery must not re-walk fingerprints that already
 * committed.
 *
 * The webhook has no partial-ack, so one unprocessable alert fails the whole
 * delivery and Alertmanager re-sends the entire batch (~16 times). Before this
 * fix every healthy sibling re-ran its full issue RPCs and re-claimed its
 * aggregate fence on every one of those retries.
 *
 * These cases run the **real fence SQL** against a real PostgreSQL (PGlite,
 * in-process WASM) with the schema built from this plugin's actual migration
 * files — the same approach as `aggregate-fence-contention.test.ts`, and for the
 * same reason: the central assertion is "the fence was never touched on
 * replay", which a hand-written model of the fence could satisfy vacuously.
 *
 * The two alerts deliberately carry DIFFERENT alertnames, so they map to
 * different aggregate keys. That is the population the fix actually helps: a
 * healthy alert in one aggregate, re-sent only because an unrelated alert in
 * another aggregate could not be processed.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  AlertDeliveryIncompleteError,
  __firingReplayCacheForTests,
  handleWebhook,
} from "../webhook-handler.js";
import { DEFAULT_ISSUE_ROUTE_MAP } from "../constants.js";
import type {
  AlertmanagerPluginConfig,
  AlertmanagerWebhookPayload,
} from "../types.js";

/** Hardcoded in the migration files, so the test schema must match. */
const NAMESPACE = "plugin_alertmanager_184163d1ba";
const FENCES_TABLE = "alertmanager_aggregate_lifecycle_fences";
const COMPANY_ID = "company-1";

const FP_HEALTHY = "fp-healthy";
const FP_BROKEN = "fp-broken";

const issueUuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let db: PGlite;

async function applyMigrations(pg: PGlite): Promise<void> {
  const dir = path.resolve(__dirname, "../../migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS public.companies (id uuid PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS public.issues (id uuid PRIMARY KEY);
    CREATE SCHEMA IF NOT EXISTS ${NAMESPACE};
  `);
  for (const file of files) {
    await pg.exec(await readFile(path.join(dir, file), "utf8"));
  }
}

/** Records every statement so a test can assert the fence path was not entered. */
function realDb(pg: PGlite, seenSql: string[]) {
  return {
    namespace: NAMESPACE,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      seenSql.push(sql);
      const result = await pg.query(sql, params as unknown[]);
      return result.rows;
    }),
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      seenSql.push(sql);
      const result = await pg.query(sql, params as unknown[]);
      return { rowCount: result.affectedRows ?? 0 };
    }),
  };
}

const baseConfig = (): AlertmanagerPluginConfig => ({
  webhookToken: "token",
  defaultCompanyId: COMPANY_ID,
  autoCloseOnResolve: true,
  issueRouteMap: DEFAULT_ISSUE_ROUTE_MAP,
  fallbackAgentName: "Alert Fallback",
});

const alertOf = (fingerprint: string, alertname: string, startsAt: string) => ({
  status: "firing" as const,
  fingerprint,
  labels: { alertname, severity: "critical" },
  annotations: { summary: `${alertname} is firing` },
  startsAt,
  endsAt: "0001-01-01T00:00:00Z",
  generatorURL: "http://prometheus/graph",
});

/**
 * One healthy alert plus one whose issue RPC fails — the shape that forces
 * Alertmanager to replay the batch.
 */
const mixedBatch = (
  startsAt = "2026-09-01T00:00:00Z",
): AlertmanagerWebhookPayload => ({
  version: "4",
  status: "firing",
  receiver: "paperclip",
  groupLabels: {},
  commonLabels: { severity: "critical" },
  commonAnnotations: {},
  externalURL: "http://alertmanager.monitoring.svc:9093",
  alerts: [
    alertOf(FP_HEALTHY, "HealthyAlert", startsAt),
    alertOf(FP_BROKEN, "BrokenAlert", startsAt),
  ],
});

const healthyOnly = (
  startsAt = "2026-09-01T00:00:00Z",
): AlertmanagerWebhookPayload => ({
  ...mixedBatch(startsAt),
  alerts: [alertOf(FP_HEALTHY, "HealthyAlert", startsAt)],
});

/**
 * The resolve that ends the `healthyOnly` firing episode. Same `startsAt`,
 * because that is what keys the replay marker the resolve has to clear.
 */
const healthyResolved = (
  startsAt = "2026-09-01T00:00:00Z",
): AlertmanagerWebhookPayload => ({
  ...mixedBatch(startsAt),
  status: "resolved",
  alerts: [
    {
      ...alertOf(FP_HEALTHY, "HealthyAlert", startsAt),
      status: "resolved" as const,
      endsAt: "2026-09-01T00:05:00Z",
    },
  ],
});

/**
 * `brokenFingerprints` names alerts whose `issues.create` throws, standing in
 * for any transient issue-RPC fault. The state store is map-backed and shared
 * across deliveries, which is what makes a replay a replay.
 */
function mkCtx(brokenFingerprints: Set<string> = new Set()) {
  const seenSql: string[] = [];
  const store = new Map<string, unknown>();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  let issueSeq = 0;

  const mocks = {
    state: {
      get: vi.fn(async (ref: unknown) => store.get(JSON.stringify(ref)) ?? null),
      set: vi.fn(async (ref: unknown, value: unknown) => {
        store.set(JSON.stringify(ref), value);
      }),
      delete: vi.fn(async (ref: unknown) => {
        store.delete(JSON.stringify(ref));
      }),
    },
    users: { get: vi.fn(async () => null), findByEmail: vi.fn(async () => null) },
    agents: {
      list: vi.fn(async () => [
        { id: "agent-fallback", name: "Alert Fallback", status: "idle" },
      ]),
    },
    issues: {
      list: vi.fn(async () => []),
      // A live, open issue. Returning null here would send every re-fire down
      // the "tracked issue could not be read" branch, which leaves state intact
      // and would make the re-fire assertions below vacuous.
      get: vi.fn(async (id: string) => ({
        id,
        status: "todo",
        assigneeUserId: null,
        assigneeAgentId: "agent-fallback",
      })),
      create: vi.fn(async (input: { originId?: string }) => {
        if (input?.originId && brokenFingerprints.has(input.originId)) {
          throw new Error(`simulated transient issue-RPC failure for ${input.originId}`);
        }
        issueSeq += 1;
        // A real UUID, because the aggregate-member tables this test runs
        // against are the real ones and type the issue id as `uuid`. A
        // readable `issue-N` parses on the firing path and only fails later,
        // on the resolve path's member lookup.
        return { id: issueUuid(issueSeq) };
      }),
      update: vi.fn(async () => ({ id: issueUuid(1) })),
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async () => ({ id: "comment-1" })),
    },
    db: realDb(db, seenSql),
    events: { emit: vi.fn(async () => {}) },
    metrics: { write: vi.fn(async () => {}) },
    activity: { log: vi.fn(async () => {}) },
    actions: { register: vi.fn() },
    secrets: {
      resolve: vi.fn(async () => "token"),
      verify: vi.fn(async () => true),
    },
    config: { get: vi.fn(async () => baseConfig()) },
    logger,
  };
  return { ctx: mocks as unknown as PluginContext, logger, mocks, seenSql, store };
}

/**
 * Backdate the replay-cache entry for a fingerprint, to exercise the window and
 * skew guards without faking the clock.
 *
 * Asserts it matched something: if the key shape changes, a silent no-op here
 * would make every test built on it pass vacuously.
 */
function shiftCachedCommit(
  ctx: PluginContext,
  fingerprint: string,
  deltaMs: number,
): void {
  const cache = __firingReplayCacheForTests(ctx);
  let touched = 0;
  for (const [key, committedAtMs] of cache) {
    if (!key.includes(fingerprint)) continue;
    cache.set(key, committedAtMs + deltaMs);
    touched += 1;
  }
  expect(touched).toBeGreaterThan(0);
}

const deliver = (
  ctx: PluginContext,
  payload: AlertmanagerWebhookPayload,
  requestId: string,
) =>
  handleWebhook(
    ctx,
    baseConfig(),
    true,
    {
      companyId: COMPANY_ID,
      endpointKey: "alertmanager",
      headers: { authorization: "Bearer token" },
      rawBody: JSON.stringify(payload),
      parsedBody: payload,
      requestId,
    } as never,
  );

const fenceStatements = (sql: string[]) =>
  sql.filter((s) => s.includes(FENCES_TABLE));

const metricNames = (write: { mock: { calls: unknown[][] } }) =>
  write.mock.calls.map((c) => c[0] as string);

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(`TRUNCATE ${NAMESPACE}.${FENCES_TABLE};`);
  // No cache reset needed: the replay cache hangs off the plugin context, and
  // every case builds its own via `mkCtx()`.
});

describe("BLO-33168 — replayed deliveries skip already-committed fingerprints", () => {
  it("replaying an all-succeeded batch re-runs no processing and claims no fence", async () => {
    const { ctx, mocks, seenSql } = mkCtx();

    await deliver(ctx, healthyOnly(), "req-1");
    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    expect(fenceStatements(seenSql).length).toBeGreaterThan(0);

    seenSql.length = 0;
    mocks.issues.create.mockClear();
    mocks.issues.update.mockClear();
    mocks.metrics.write.mockClear();

    // The replay must resolve, not throw: nothing failed, so the delivery is
    // complete even though it did no work. Asserted as "did not reject" rather
    // than on a shape, so a change to the summary handleWebhook returns cannot
    // silently turn this into a vacuous pass.
    await expect(deliver(ctx, healthyOnly(), "req-1-retry")).resolves.not.toThrow();

    expect(fenceStatements(seenSql)).toEqual([]);
    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(metricNames(mocks.metrics.write)).toContain(
      "alertmanager.alert.replay_skipped",
    );
  });

  it("a batch with an unprocessable alert still fails as a whole on every replay", async () => {
    const { ctx, mocks } = mkCtx(new Set([FP_BROKEN]));

    // First pass: the healthy alert commits, the broken one does not, so the
    // delivery fails and Alertmanager will retry it.
    await expect(deliver(ctx, mixedBatch(), "req-2")).rejects.toBeInstanceOf(
      AlertDeliveryIncompleteError,
    );

    mocks.issues.create.mockClear();

    // The replay must STILL fail — this is the BLO-20467 guard. Answering 200
    // here would end the retries and destroy the alert.
    await expect(
      deliver(ctx, mixedBatch(), "req-2-retry"),
    ).rejects.toBeInstanceOf(AlertDeliveryIncompleteError);

    // ...and it must fail for the broken alert ALONE, not for the sibling the
    // skip just stepped over.
    await expect(deliver(ctx, mixedBatch(), "req-2-retry-2")).rejects.toMatchObject(
      { fingerprints: [FP_BROKEN] },
    );
  });

  it("a fingerprint that never committed is retried normally on replay", async () => {
    const { ctx, mocks, seenSql } = mkCtx(new Set([FP_BROKEN]));

    await expect(deliver(ctx, mixedBatch(), "req-3")).rejects.toBeInstanceOf(
      AlertDeliveryIncompleteError,
    );

    seenSql.length = 0;
    mocks.issues.create.mockClear();
    mocks.issues.update.mockClear();
    mocks.metrics.write.mockClear();

    await expect(deliver(ctx, mixedBatch(), "req-3-retry")).rejects.toBeInstanceOf(
      AlertDeliveryIncompleteError,
    );

    // The broken alert is reprocessed in full: it claims its fence and reaches
    // the issue RPC again.
    expect(fenceStatements(seenSql).length).toBeGreaterThan(0);
    const attempted = mocks.issues.create.mock.calls.map(
      (c) => (c[0] as { originId?: string }).originId,
    );
    expect(attempted).toContain(FP_BROKEN);

    // ...while the committed sibling is skipped. Asserted via the skip metric
    // and the absent re-fire update, NOT via `attempted`: the healthy alert
    // already has state, so on replay it would take the re-fire path and call
    // `issues.update` rather than `issues.create`. An assertion that it is
    // absent from the CREATE calls therefore holds whether or not the skip
    // exists, and passes with the fix removed.
    expect(metricNames(mocks.metrics.write)).toContain(
      "alertmanager.alert.replay_skipped",
    );
    expect(mocks.issues.update).not.toHaveBeenCalled();
  });

  it("a new firing episode for the same fingerprint is not skipped", async () => {
    const { ctx, mocks } = mkCtx();

    await deliver(ctx, healthyOnly("2026-09-01T00:00:00Z"), "req-4");
    mocks.issues.update.mockClear();
    mocks.metrics.write.mockClear();

    // Same fingerprint, different startsAt — the alert cleared and re-fired, so
    // this carries real transitions even though it is inside the time window.
    await deliver(ctx, healthyOnly("2026-09-02T00:00:00Z"), "req-4-refire");

    expect(metricNames(mocks.metrics.write)).not.toContain(
      "alertmanager.alert.replay_skipped",
    );
    expect(mocks.issues.update).toHaveBeenCalled();
  });

  it("a resolve landing after the firing pass defeats the skip", async () => {
    const { ctx, mocks } = mkCtx();

    await deliver(ctx, healthyOnly(), "req-5");

    // A real resolve delivery lands between our firing pass and the replay, so
    // the issue is closed and a later firing delivery has to re-open it.
    // Skipping that delivery would strand a cleared-then-refiring alert on a
    // closed issue, so the resolve has to drop the replay marker.
    await deliver(ctx, healthyResolved(), "req-5-resolve");
    mocks.metrics.write.mockClear();
    mocks.issues.update.mockClear();

    await deliver(ctx, healthyOnly(), "req-5-retry");

    expect(metricNames(mocks.metrics.write)).not.toContain(
      "alertmanager.alert.replay_skipped",
    );
    expect(mocks.issues.update).toHaveBeenCalled();
  });

  it("an operator-suppressed pass writes no marker, so an in-window suppression expiry re-opens", async () => {
    const { ctx, mocks, store } = mkCtx();

    await deliver(ctx, healthyOnly(), "req-8");

    // A human closes the issue while the alert keeps firing. Age the creation
    // pass's marker out first: that pass legitimately committed, and only the
    // suppressed pass after it is under test.
    mocks.issues.get.mockImplementation(async (id: string) => ({
      id,
      status: "done",
      assigneeUserId: null,
      assigneeAgentId: "agent-fallback",
    }));
    shiftCachedCommit(ctx, FP_HEALTHY, -(60 * 60_000));
    mocks.metrics.write.mockClear();

    await deliver(ctx, healthyOnly(), "req-8-suppressed");
    expect(metricNames(mocks.metrics.write)).toContain("alertmanager.firing.suppressed");

    // The suppression window elapses between this delivery and its replay —
    // the expiry instant falls inside the replay window. Backdate the anchor
    // rather than fake the clock, and assert it matched so a renamed field
    // cannot turn this into a vacuous pass.
    let anchors = 0;
    for (const [key, value] of store) {
      const record = value as { operatorSuppressedAt?: string | null } | null;
      if (!record?.operatorSuppressedAt) continue;
      store.set(key, {
        ...record,
        operatorSuppressedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
      });
      anchors += 1;
    }
    expect(anchors).toBeGreaterThan(0);
    mocks.metrics.write.mockClear();
    mocks.issues.update.mockClear();

    await deliver(ctx, healthyOnly(), "req-8-retry");

    expect(metricNames(mocks.metrics.write)).not.toContain(
      "alertmanager.alert.replay_skipped",
    );
    expect(metricNames(mocks.metrics.write)).toContain(
      "alertmanager.firing.suppression_expired",
    );
    expect(mocks.issues.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "todo" }),
      COMPANY_ID,
      undefined,
      expect.anything(),
    );
  });

  it("a delivery arriving after the replay window is processed, not skipped", async () => {
    const { ctx, mocks } = mkCtx();

    await deliver(ctx, healthyOnly(), "req-6");
    mocks.metrics.write.mockClear();
    mocks.issues.update.mockClear();

    // Backdate the committed firing pass well past ALERT_REPLAY_SKIP_WINDOW_MS.
    // This is a `repeat_interval` re-send, not a retry — Alertmanager carries no
    // delivery id, so elapsed time is the only thing separating the two, and an
    // unbounded window would silently swallow every genuine re-fire.
    shiftCachedCommit(ctx, FP_HEALTHY, -(60 * 60_000));

    await deliver(ctx, healthyOnly(), "req-6-repeat");

    expect(metricNames(mocks.metrics.write)).not.toContain(
      "alertmanager.alert.replay_skipped",
    );
    expect(mocks.issues.update).toHaveBeenCalled();
  });

  it("a future-dated commit from a backwards clock step is not skipped", async () => {
    const { ctx, mocks } = mkCtx();

    await deliver(ctx, healthyOnly(), "req-7");
    mocks.metrics.write.mockClear();
    mocks.issues.update.mockClear();

    // The cache is written with this process's own `Date.now()`, so the way an
    // entry lands in the future is the clock stepping backwards under it (NTP).
    // Elapsed time is then negative, which is trivially "inside" the window — so
    // without the lower bound one step would mute this fingerprint for the whole
    // skew, which is unbounded.
    shiftCachedCommit(ctx, FP_HEALTHY, 60 * 60_000);

    await deliver(ctx, healthyOnly(), "req-7-skewed");

    expect(metricNames(mocks.metrics.write)).not.toContain(
      "alertmanager.alert.replay_skipped",
    );
    expect(mocks.issues.update).toHaveBeenCalled();
  });
});
