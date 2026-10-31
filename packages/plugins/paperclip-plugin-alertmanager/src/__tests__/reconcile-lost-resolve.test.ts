/**
 * BLO-51097 — a resolve delivery lost to a control-plane restart must not
 * strand the alert's issue open forever.
 *
 * Runs the real push path (`handleWebhook`) and the real aggregate SQL against
 * PGlite built from this plugin's migrations, so the assertions are about what
 * the resolve path actually does to the member table and the issue — not about
 * a model of it.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { handleWebhook, readAlertState } from "../webhook-handler.js";
import {
  RECONCILE_GRACE_MS,
  __resetLostResolveObservationsForTests,
  reconcileActiveAlerts,
} from "../reconcile.js";
import { DEFAULT_ISSUE_ROUTE_MAP } from "../constants.js";
import type { AlertmanagerPluginConfig, AlertmanagerWebhookPayload } from "../types.js";

const NAMESPACE = "plugin_alertmanager_184163d1ba";
const COMPANY_ID = "company-1";

let db: PGlite;

async function applyMigrations(pg: PGlite): Promise<void> {
  const dir = path.resolve(__dirname, "../../migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS public.companies (id uuid PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS public.issues (id uuid PRIMARY KEY);
    CREATE SCHEMA IF NOT EXISTS ${NAMESPACE};
  `);
  for (const file of files) await pg.exec(await readFile(path.join(dir, file), "utf8"));
}

const config = (): AlertmanagerPluginConfig => ({
  webhookToken: "token",
  defaultCompanyId: COMPANY_ID,
  autoCloseOnResolve: true,
  issueRouteMap: DEFAULT_ISSUE_ROUTE_MAP,
  fallbackAgentName: "Alert Fallback",
  alertmanagerApiUrl: "http://am:9093",
  reconcileReceivers: ["paperclip"],
});

function mkCtx() {
  const store = new Map<string, unknown>();
  const issues = new Map<
    string,
    { id: string; status: string; companyId?: string; originId?: string; originFingerprint?: string }
  >();
  let seq = 0;
  const mocks = {
    state: {
      get: vi.fn(async (ref: unknown) => store.get(JSON.stringify(ref)) ?? null),
      set: vi.fn(async (ref: unknown, value: unknown) => void store.set(JSON.stringify(ref), value)),
      delete: vi.fn(async (ref: unknown) => void store.delete(JSON.stringify(ref))),
    },
    users: { get: vi.fn(async () => null), findByEmail: vi.fn(async () => null) },
    agents: { list: vi.fn(async () => [{ id: "agent-fallback", name: "Alert Fallback", status: "idle" }]) },
    issues: {
      // Enough of the host filter for findActiveAggregateIssue to find the live row.
      list: vi.fn(
        async (f: { companyId?: string; originId?: string; originFingerprint?: string; status?: string }) =>
          [...issues.values()].filter(
            (i) =>
              (!f.companyId || i.companyId === f.companyId) &&
              (!f.originId || i.originId === f.originId) &&
              (!f.originFingerprint || i.originFingerprint === f.originFingerprint) &&
              (!f.status || i.status === f.status),
          ),
      ),
      get: vi.fn(async (id: string) =>
        issues.has(id) ? { ...issues.get(id)!, assigneeUserId: null, assigneeAgentId: "agent-fallback" } : null,
      ),
      create: vi.fn(async (input: { companyId?: string; originId?: string; originFingerprint?: string }) => {
        seq += 1;
        const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
        issues.set(id, {
          id,
          status: "todo",
          companyId: input?.companyId,
          originId: input?.originId,
          originFingerprint: input?.originFingerprint,
        });
        return { id };
      }),
      update: vi.fn(async (id: string, patch: { status?: string }) => {
        if (patch.status) issues.get(id)!.status = patch.status;
        return { id };
      }),
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async () => ({ id: "c" })),
    },
    db: {
      namespace: NAMESPACE,
      query: vi.fn(async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows),
      execute: vi.fn(async (sql: string, params: unknown[] = []) => ({
        rowCount: (await db.query(sql, params)).affectedRows ?? 0,
      })),
    },
    events: { emit: vi.fn(async () => {}) },
    metrics: { write: vi.fn(async () => {}), observe: vi.fn(async () => {}) },
    activity: { log: vi.fn(async () => {}) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  return { ctx: mocks as unknown as PluginContext, issues };
}

const alertOf = (fingerprint: string, startsAt: string, alertname = "ArgoAutoSyncAppNotConverging") => ({
  status: "firing" as const,
  fingerprint,
  labels: { alertname, severity: "critical" },
  annotations: { summary: `${alertname} is firing` },
  startsAt,
  endsAt: "0001-01-01T00:00:00Z",
});

const fire = (ctx: PluginContext, alerts: ReturnType<typeof alertOf>[], companyId = COMPANY_ID) =>
  handleWebhook(ctx, { ...config(), defaultCompanyId: companyId }, true, {
    companyId,
    endpointKey: "alertmanager",
    parsedBody: {
      version: "4",
      status: "firing",
      receiver: "paperclip",
      alerts,
    } satisfies AlertmanagerWebhookPayload,
  } as never);

/** What Alertmanager holds right now. */
let held: unknown[] = [];
const amEntry = (fp: string, startsAt: string) => ({
  ...alertOf(fp, startsAt),
  receivers: [{ name: "paperclip" }],
  status: { state: "active" },
});

const T0 = new Date("2026-10-31T21:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
});
afterAll(async () => db.close());
beforeEach(async () => {
  __resetLostResolveObservationsForTests();
  held = [];
  await db.exec(`
    TRUNCATE ${NAMESPACE}.alertmanager_aggregate_members;
    TRUNCATE ${NAMESPACE}.alertmanager_aggregate_lifecycle_fences;
    TRUNCATE ${NAMESPACE}.alertmanager_aggregate_creation_claims;
  `);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(held), { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("BLO-51097 — reconcile resolves alerts whose resolve delivery was lost", () => {
  it("cancels the issue, records plugin authorship, and a later re-fire re-opens it", async () => {
    const { ctx, issues } = mkCtx();
    await fire(ctx, [alertOf("fp-a", "2026-10-31T14:50:00Z")]);
    const [issueId] = [...issues.keys()];
    expect(issues.get(issueId)!.status).toBe("todo");

    // Resolve delivery dropped; Alertmanager no longer holds the alert.
    const first = await reconcileActiveAlerts(ctx, config(), T0);
    expect(first.resolved).toEqual([]); // one absent read is never enough
    expect(issues.get(issueId)!.status).toBe("todo");

    const second = await reconcileActiveAlerts(ctx, config(), later(RECONCILE_GRACE_MS));
    expect(second.resolved).toEqual(["fp-a"]);
    expect(issues.get(issueId)!.status).toBe("cancelled");
    const { record } = await readAlertState(ctx, COMPANY_ID, "fp-a");
    expect(record?.resolvedAt).toBe(later(RECONCILE_GRACE_MS).toISOString());
    expect(record?.pluginClosedAt).toBe(later(RECONCILE_GRACE_MS).toISOString());

    // Nothing left to resolve on the next pass.
    expect((await reconcileActiveAlerts(ctx, config(), later(3 * RECONCILE_GRACE_MS))).resolved).toEqual([]);

    // A genuine recurrence re-opens rather than being muted as an operator close.
    await fire(ctx, [alertOf("fp-a", "2026-11-01T02:00:00Z")]);
    expect(issues.get(issueId)!.status).not.toBe("cancelled");
  });

  it("does not resolve an alert that was only briefly absent (Alertmanager restart)", async () => {
    const { ctx, issues } = mkCtx();
    await fire(ctx, [alertOf("fp-b", "2026-10-31T14:50:00Z")]);
    const [issueId] = [...issues.keys()];

    await reconcileActiveAlerts(ctx, config(), T0); // empty read: marked absent
    held = [amEntry("fp-b", "2026-10-31T14:50:00Z")];
    await reconcileActiveAlerts(ctx, config(), later(60_000)); // back: mark cleared
    held = [];
    const r = await reconcileActiveAlerts(ctx, config(), later(RECONCILE_GRACE_MS + 60_000));
    expect(r.resolved).toEqual([]); // absence clock restarted
    expect(issues.get(issueId)!.status).toBe("todo");
  });

  it("does not finalize an aggregate whose sibling Alertmanager still holds", async () => {
    const { ctx, issues } = mkCtx();
    await fire(ctx, [alertOf("fp-s1", "2026-10-31T14:50:00Z"), alertOf("fp-s2", "2026-10-31T14:51:00Z")]);
    expect(issues.size).toBe(1); // one aggregate row
    const [issueId] = [...issues.keys()];

    held = [amEntry("fp-s2", "2026-10-31T14:51:00Z")];
    await reconcileActiveAlerts(ctx, config(), T0);
    const r = await reconcileActiveAlerts(ctx, config(), later(RECONCILE_GRACE_MS));
    expect(r.resolved).toEqual(["fp-s1"]);
    expect(issues.get(issueId)!.status).toBe("todo");
    const rows = await db.query<{ fingerprint: string; resolved: boolean }>(
      `SELECT fingerprint, resolved_at IS NOT NULL AS resolved
         FROM ${NAMESPACE}.alertmanager_aggregate_members ORDER BY fingerprint`,
    );
    expect(rows.rows).toEqual([
      { fingerprint: "fp-s1", resolved: true },
      { fingerprint: "fp-s2", resolved: false },
    ]);
  });

  it("treats a silenced alert as still held", async () => {
    const { ctx, issues } = mkCtx();
    await fire(ctx, [alertOf("fp-q", "2026-10-31T14:50:00Z")]);
    const [issueId] = [...issues.keys()];
    held = [{ ...amEntry("fp-q", "2026-10-31T14:50:00Z"), status: { state: "suppressed" } }];
    await reconcileActiveAlerts(ctx, config(), T0);
    await reconcileActiveAlerts(ctx, config(), later(RECONCILE_GRACE_MS));
    expect(issues.get(issueId)!.status).toBe("todo");
  });

  it("keeps absence marks per company, so interleaved company passes still resolve", async () => {
    const { ctx, issues } = mkCtx();
    const cfgB = { ...config(), defaultCompanyId: "company-2" };
    await fire(ctx, [alertOf("fp-ca", "2026-10-31T14:50:00Z")]);
    await fire(ctx, [alertOf("fp-cb", "2026-10-31T14:50:00Z")], "company-2");
    expect(issues.size).toBe(2);

    // The scheduler dispatches once per company; each pass must not prune the other's marks.
    await reconcileActiveAlerts(ctx, config(), T0);
    await reconcileActiveAlerts(ctx, cfgB, T0);
    expect((await reconcileActiveAlerts(ctx, config(), later(RECONCILE_GRACE_MS))).resolved).toEqual(["fp-ca"]);
    expect((await reconcileActiveAlerts(ctx, cfgB, later(RECONCILE_GRACE_MS))).resolved).toEqual(["fp-cb"]);
    expect([...issues.values()].map((i) => i.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("does not resolve a member re-fired between the Alertmanager read and the replay", async () => {
    const { ctx, issues } = mkCtx();
    await fire(ctx, [alertOf("fp-r", "2026-10-31T14:50:00Z")]);
    const [issueId] = [...issues.keys()];
    await reconcileActiveAlerts(ctx, config(), T0);

    // Simulate a firing delivery landing just before the pre-replay re-check.
    const query = ctx.db.query as ReturnType<typeof vi.fn>;
    const real = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("resolved_at::text AS resolved_at")) {
        await db.query(
          `UPDATE ${NAMESPACE}.alertmanager_aggregate_members SET updated_at = updated_at + interval '1 second' WHERE fingerprint = 'fp-r'`,
        );
      }
      return real(sql, params);
    });
    const r = await reconcileActiveAlerts(ctx, config(), later(RECONCILE_GRACE_MS));
    expect(r.resolved).toEqual([]);
    expect(issues.get(issueId)!.status).toBe("todo");
  });
});
