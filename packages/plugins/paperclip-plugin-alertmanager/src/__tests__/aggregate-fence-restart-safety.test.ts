/**
 * BLO-31036 — the aggregate lifecycle fence must be restart-safe.
 *
 * A firing delivery claims the fence, then releases it in a `finally`. Nothing
 * between the claim and the `try` can throw, so an exception can never wedge
 * one; only death of the owning process between claim and release can, which is
 * what every rollout does. In production 19 aggregates sat in `firing`
 * indefinitely, each 502-ing every subsequent delivery for its key, drainable
 * only through an operator-only route that needs the dead process's token.
 *
 * These cases run the **real SQL against a real PostgreSQL** (PGlite, in-process
 * WASM — no external service, no container), with the schema built by executing
 * this plugin's **actual migration files** in order. So the fence predicate
 * itself is under test, not a hand-written model of it: deleting the steal
 * clause from `beginAggregateFiring` fails these tests.
 *
 * That distinction is the whole reason this file exists. An earlier draft used a
 * JS model of the fence table and 9 of its 10 cases still passed with the fix
 * removed — it was asserting the model, not the behaviour.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  AlertDeliveryIncompleteError,
  handleWebhook,
  reconcileAbandonedAggregateFences,
  workerFenceIdentity,
} from "../webhook-handler.js";
import { DEFAULT_ISSUE_ROUTE_MAP } from "../constants.js";
import type {
  AlertmanagerPluginConfig,
  AlertmanagerWebhookPayload,
} from "../types.js";

/** Hardcoded in the migration files, so the test schema must match. */
const NAMESPACE = "plugin_alertmanager_184163d1ba";
const FENCES = `${NAMESPACE}.alertmanager_aggregate_lifecycle_fences`;
const COMPANY_ID = "company-1";
const ALERTNAME = "CronJobSuccessStale";
const AGGREGATE_KEY = `alert-aggregate:v1:["${ALERTNAME}",null]`;

/** The identity the code under test claims fences under. */
const SELF = workerFenceIdentity();
/** A previous occupant of this same slot: the process a rollout killed. */
const DEAD_PREDECESSOR = { instanceId: "instance-dead-predecessor", slot: SELF.slot };
/** A concurrent host in a different slot — never assumed dead. */
const FOREIGN_HOST = { instanceId: "instance-foreign", slot: "paperclip-api-xyz" };

let db: PGlite;

/**
 * Apply every migration in `migrations/`, in filename order, exactly as the
 * host's migration runner does. Using the real files means a fence column this
 * code depends on cannot be missing from the migration that ships with it.
 */
async function applyMigrations(pg: PGlite): Promise<void> {
  const dir = path.resolve(__dirname, "../../migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  expect(files).toContain("005_aggregate_fence_owner_instance.sql");
  // The escalation-cover migrations carry FKs into core tables the host owns.
  // Stub only the columns those FKs reference; the fence table itself has no
  // core dependency, which is why it can be exercised in isolation here.
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS public.companies (id uuid PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS public.issues (id uuid PRIMARY KEY);
    CREATE SCHEMA IF NOT EXISTS ${NAMESPACE};
  `);
  for (const file of files) {
    await pg.exec(await readFile(path.join(dir, file), "utf8"));
  }
}

/** A `ctx.db` backed by the real database. */
function realDb(pg: PGlite) {
  return {
    namespace: NAMESPACE,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const result = await pg.query(sql, params as unknown[]);
      return result.rows;
    }),
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      const result = await pg.query(sql, params as unknown[]);
      return { rowCount: result.affectedRows ?? 0 };
    }),
  };
}

/** Put the fence row into a chosen held state, as a dead process would leave it. */
async function seedFence(row: {
  phase: string;
  firingToken?: string | null;
  resolutionToken?: string | null;
  ownerInstanceId: string | null;
  ownerSlot: string | null;
  updatedAt?: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO ${FENCES}
       (company_id, aggregate_key, phase, firing_token, resolution_token,
        owner_instance_id, owner_slot, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      COMPANY_ID,
      AGGREGATE_KEY,
      row.phase,
      row.firingToken ?? null,
      row.resolutionToken ?? null,
      row.ownerInstanceId,
      row.ownerSlot,
      row.updatedAt ?? new Date().toISOString(),
    ],
  );
}

async function readFence(): Promise<
  | {
      phase: string;
      firing_token: string | null;
      owner_instance_id: string | null;
      owner_slot: string | null;
    }
  | undefined
> {
  const result = await db.query<{
    phase: string;
    firing_token: string | null;
    owner_instance_id: string | null;
    owner_slot: string | null;
  }>(
    `SELECT phase, firing_token, owner_instance_id, owner_slot
       FROM ${FENCES} WHERE company_id = $1 AND aggregate_key = $2`,
    [COMPANY_ID, AGGREGATE_KEY],
  );
  return result.rows[0];
}

const baseConfig = (): AlertmanagerPluginConfig => ({
  webhookToken: "token",
  defaultCompanyId: COMPANY_ID,
  autoCloseOnResolve: true,
  issueRouteMap: DEFAULT_ISSUE_ROUTE_MAP,
  fallbackAgentName: "Alert Fallback",
});

const firingPayload = (): AlertmanagerWebhookPayload => ({
  version: "4",
  status: "firing",
  receiver: "paperclip",
  groupLabels: { alertname: ALERTNAME },
  commonLabels: { alertname: ALERTNAME, severity: "critical" },
  commonAnnotations: {},
  externalURL: "http://alertmanager.monitoring.svc:9093",
  alerts: [
    {
      status: "firing",
      fingerprint: "fp-restart-safety",
      labels: { alertname: ALERTNAME, severity: "critical" },
      annotations: { summary: "cronjob has not succeeded recently" },
      startsAt: "2026-09-01T00:00:00Z",
      endsAt: "0001-01-01T00:00:00Z",
      generatorURL: "http://prometheus/graph",
    },
  ],
});

function mkCtx() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mocks = {
    state: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
    users: { get: vi.fn(async () => null), findByEmail: vi.fn(async () => null) },
    agents: {
      list: vi.fn(async () => [
        { id: "agent-fallback", name: "Alert Fallback", status: "idle" },
      ]),
    },
    issues: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "issue-1" })),
      update: vi.fn(async () => ({ id: "issue-1" })),
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async () => ({ id: "comment-1" })),
    },
    db: realDb(db),
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
  return { ctx: mocks as unknown as PluginContext, logger, mocks };
}

const deliver = (ctx: PluginContext) =>
  handleWebhook(ctx, baseConfig(), true, {
    companyId: COMPANY_ID,
    endpointKey: "alertmanager",
    headers: { authorization: "Bearer token" },
    rawBody: JSON.stringify(firingPayload()),
    parsedBody: firingPayload(),
    requestId: "req-restart-safety",
  } as never);

beforeEach(async () => {
  db = new PGlite();
  await applyMigrations(db);
});

afterEach(async () => {
  await db.close();
});

describe("BLO-31036 — a fence abandoned by a dead process stops wedging its aggregate", () => {
  it("admits the next delivery when the fence is held by a dead predecessor in this slot", async () => {
    // Exactly the production state: `firing`, holding a token no live process
    // has, last advanced seconds before this process started.
    await seedFence({
      phase: "firing",
      firingToken: "token-from-the-dead-process",
      ownerInstanceId: DEAD_PREDECESSOR.instanceId,
      ownerSlot: DEAD_PREDECESSOR.slot,
      updatedAt: "2026-08-31T12:09:04Z",
    });
    const { ctx } = mkCtx();

    await expect(deliver(ctx)).resolves.toBeUndefined();

    // Reclaimed, then released cleanly in the `finally` — back to `active`
    // rather than newly wedged.
    const fence = await readFence();
    expect(fence?.phase).toBe("active");
    expect(fence?.firing_token).toBeNull();
    expect(fence?.owner_instance_id).toBeNull();
  });

  it("refuses to steal a fence held by a live delivery in this same process", async () => {
    // Deliveries genuinely interleave inside one worker process: the RPC layer
    // pipelines handleWebhook calls into the single child. A per-delivery
    // identity would let two concurrent firings steal each other's fences,
    // which is the race the fence exists to prevent.
    await seedFence({
      phase: "firing",
      firingToken: "token-held-by-live-sibling",
      ownerInstanceId: SELF.instanceId,
      ownerSlot: SELF.slot,
    });
    const { ctx, logger } = mkCtx();

    await expect(deliver(ctx)).rejects.toThrow(AlertDeliveryIncompleteError);
    expect(logger.error.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "is held in phase 'firing'",
    );
    expect((await readFence())?.firing_token).toBe("token-held-by-live-sibling");
  });

  it("refuses to steal a fence held by another slot, even in a terminal phase", async () => {
    // The singleton worker rests partly on chart config (an unknown
    // PAPERCLIP_NODE_ROLE falls back to "all"), so a second plugin host is a
    // misconfiguration away. Keying the steal on the slot means such a host's
    // in-flight cancellation is never stolen.
    await seedFence({
      phase: "cancelling",
      resolutionToken: "resolution-token-foreign",
      ownerInstanceId: FOREIGN_HOST.instanceId,
      ownerSlot: FOREIGN_HOST.slot,
    });
    const { ctx } = mkCtx();

    await expect(deliver(ctx)).rejects.toThrow(AlertDeliveryIncompleteError);
    expect((await readFence())?.phase).toBe("cancelling");
  });

  it("never releases a fence on age alone — an ancient fence owned by this process still refuses", async () => {
    // The property AC-4 asks for. A lease would have released this; identity
    // does not, because elapsed time is not evidence that an owner has died.
    await seedFence({
      phase: "firing",
      firingToken: "token-old-but-live",
      ownerInstanceId: SELF.instanceId,
      ownerSlot: SELF.slot,
      updatedAt: "2020-01-01T00:00:00Z",
    });
    const { ctx } = mkCtx();

    await expect(deliver(ctx)).rejects.toThrow(AlertDeliveryIncompleteError);
    expect((await readFence())?.phase).toBe("firing");
  });

  it("still admits a claim over an idle or finalizing fence", async () => {
    // The pre-existing admission set must be unchanged by the steal clause.
    await seedFence({
      phase: "finalizing",
      resolutionToken: "resolution-token-live",
      ownerInstanceId: SELF.instanceId,
      ownerSlot: SELF.slot,
    });
    const { ctx } = mkCtx();

    await expect(deliver(ctx)).resolves.toBeUndefined();
    expect((await readFence())?.phase).toBe("active");
  });
});

describe("BLO-31036 — startup reconciliation drains fences no live process can release", () => {
  it("releases a stale-instance fence so an aggregate that stopped firing is not wedged forever", async () => {
    // The per-claim steal only helps aggregates that fire again. An alert that
    // has since cleared sends no further delivery, so without this sweep its
    // row would sit in `firing` permanently and violate the 15-minute invariant.
    await seedFence({
      phase: "firing",
      firingToken: "token-from-the-dead-process",
      ownerInstanceId: DEAD_PREDECESSOR.instanceId,
      ownerSlot: DEAD_PREDECESSOR.slot,
    });
    const { ctx, logger } = mkCtx();

    await expect(reconcileAbandonedAggregateFences(ctx)).resolves.toBe(1);
    expect((await readFence())?.phase).toBe("active");
    expect(logger.warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "abandoned by a previous occupant",
    );
  });

  it("releases a legacy fence whose owner predates instance fencing", async () => {
    // The 19 rows already wedged in production carry NULL owners: they were
    // written before the column existed, therefore by a strictly older image,
    // therefore by a process this one has replaced. This is the case that
    // drains them on deploy.
    await seedFence({
      phase: "firing",
      firingToken: "token-pre-migration",
      ownerInstanceId: null,
      ownerSlot: null,
    });
    const { ctx } = mkCtx();

    await expect(reconcileAbandonedAggregateFences(ctx)).resolves.toBe(1);
    expect((await readFence())?.phase).toBe("active");
  });

  it("leaves a fence held by this process alone, so a delivery racing setup survives", async () => {
    // `pluginCtx` is assigned at the top of setup, so a delivery can arrive
    // while the sweep is still running. It must not be collateral damage.
    await seedFence({
      phase: "firing",
      firingToken: "token-live",
      ownerInstanceId: SELF.instanceId,
      ownerSlot: SELF.slot,
    });
    const { ctx } = mkCtx();

    await expect(reconcileAbandonedAggregateFences(ctx)).resolves.toBe(0);
    expect((await readFence())?.phase).toBe("firing");
  });

  it("leaves another slot's fence alone", async () => {
    await seedFence({
      phase: "cancelling",
      resolutionToken: "resolution-token-foreign",
      ownerInstanceId: FOREIGN_HOST.instanceId,
      ownerSlot: FOREIGN_HOST.slot,
    });
    const { ctx } = mkCtx();

    await expect(reconcileAbandonedAggregateFences(ctx)).resolves.toBe(0);
    expect((await readFence())?.phase).toBe("cancelling");
  });

  it("leaves an `active` fence untouched", async () => {
    await seedFence({
      phase: "active",
      ownerInstanceId: null,
      ownerSlot: null,
    });
    const { ctx } = mkCtx();

    await expect(reconcileAbandonedAggregateFences(ctx)).resolves.toBe(0);
    expect((await readFence())?.phase).toBe("active");
  });

  it("is non-fatal when the sweep query fails, so the worker still starts", async () => {
    // Throwing here would stop the worker booting at all, turning a set of
    // wedged aggregates into total alert loss. The per-claim steal remains.
    const { ctx, mocks, logger } = mkCtx();
    mocks.db.execute.mockRejectedValueOnce(new Error("connection reset"));

    await expect(reconcileAbandonedAggregateFences(ctx)).resolves.toBe(0);
    expect(logger.error.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "reconciliation failed",
    );
  });
});
