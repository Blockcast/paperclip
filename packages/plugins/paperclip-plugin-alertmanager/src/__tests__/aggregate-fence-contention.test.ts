/**
 * PEN-3013 — routine fence contention must not fail deliveries.
 *
 * The aggregate fence is keyed on the creation identity
 * (`alert-aggregate:v1:[alertname, dedupe-domain]`), so every alert sharing an
 * alertname contends for one fence. That convergence is deliberate: the key is
 * also `origin_fingerprint`, which a partial UNIQUE index on `issues` uses to
 * hold one open issue per aggregate. Widening it would change which alerts share
 * an issue, so contention cannot be designed away here — it can only be waited
 * out.
 *
 * Before this fix a held fence failed the delivery immediately, which produced
 * two measured failure modes in production:
 *   1. three unrelated cronjobs in three namespaces, contending only because
 *      they share `CronJobSuccessStale`, each returning 502;
 *   2. Alertmanager retrying that 502 into the delivery still holding the fence,
 *      sustaining the episode until the restart fan-out settled.
 *
 * These cases run the **real fence SQL** against a real PostgreSQL (PGlite,
 * in-process WASM) with the schema built from this plugin's actual migration
 * files — the same approach as `aggregate-fence-restart-safety.test.ts`, and for
 * the same reason: a hand-written model of the fence would pass with the fix
 * removed.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  AlertDeliveryIncompleteError,
  type AggregateFenceWaitPolicy,
  handleWebhook,
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
/** The alertname from the production evidence, which fanned out across namespaces. */
const ALERTNAME = "CronJobSuccessStale";

/** The identity the code under test claims fences under. */
const SELF = workerFenceIdentity();

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

const baseConfig = (): AlertmanagerPluginConfig => ({
  webhookToken: "token",
  defaultCompanyId: COMPANY_ID,
  autoCloseOnResolve: true,
  issueRouteMap: DEFAULT_ISSUE_ROUTE_MAP,
  fallbackAgentName: "Alert Fallback",
});

/**
 * One firing alert for a specific k8s object. Distinct `namespace`/`cronjob`
 * labels and a distinct fingerprint, but no `paperclip_dedupe_domain` — so these
 * deliberately collapse onto ONE aggregate key, exactly as production did.
 */
const firingPayloadFor = (
  namespace: string,
  cronjob: string,
  fingerprint: string,
): AlertmanagerWebhookPayload => ({
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
      fingerprint,
      labels: { alertname: ALERTNAME, severity: "critical", namespace, cronjob },
      annotations: { summary: `${cronjob} has not succeeded recently` },
      startsAt: "2026-09-01T00:00:00Z",
      endsAt: "0001-01-01T00:00:00Z",
      generatorURL: "http://prometheus/graph",
    },
  ],
});

/**
 * A batch of alerts about distinct objects that all share the alertname — so
 * they all map to ONE aggregate key, which is exactly the shape Alertmanager
 * delivers when it groups by alertname.
 */
const firingBatchOf = (size: number): AlertmanagerWebhookPayload => ({
  version: "4",
  status: "firing",
  receiver: "paperclip",
  groupLabels: { alertname: ALERTNAME },
  commonLabels: { alertname: ALERTNAME, severity: "critical" },
  commonAnnotations: {},
  externalURL: "http://alertmanager.monitoring.svc:9093",
  alerts: Array.from({ length: size }, (_, i) => ({
    status: "firing" as const,
    fingerprint: `fp-batch-${i}`,
    labels: {
      alertname: ALERTNAME,
      severity: "critical",
      namespace: `ns-${i}`,
      cronjob: `cronjob-${i}`,
    },
    annotations: { summary: `cronjob-${i} has not succeeded recently` },
    startsAt: "2026-09-01T00:00:00Z",
    endsAt: "0001-01-01T00:00:00Z",
    generatorURL: "http://prometheus/graph",
  })),
});

function mkCtx(overrides: { onIssueCreate?: () => Promise<void> } = {}) {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mocks = {
    state: {
      get: vi.fn(async () => null),
      set: vi.fn(async (..._args: unknown[]) => {}),
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
      create: vi.fn(async () => {
        await overrides.onIssueCreate?.();
        return { id: "issue-1" };
      }),
      update: vi.fn(async () => ({ id: "issue-1" })),
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async () => ({ id: "comment-1" })),
    },
    db: realDb(db),
    events: { emit: vi.fn(async (..._args: unknown[]) => {}) },
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

const deliver = (
  ctx: PluginContext,
  payload: AlertmanagerWebhookPayload,
  requestId: string,
  policy?: Partial<AggregateFenceWaitPolicy>,
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
    policy,
  );

/** Real timing is what the fix is about, so only the budget is shortened. */
const fastPolicy = (
  overrides: Partial<AggregateFenceWaitPolicy> = {},
): AggregateFenceWaitPolicy => ({
  budgetMs: 400,
  initialDelayMs: 5,
  maxDelayMs: 20,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  random: () => Math.random(),
  ...overrides,
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  db = new PGlite();
  await applyMigrations(db);
});

afterEach(async () => {
  await db.close();
});

describe("PEN-3013 — two distinct objects under one alertname both deliver", () => {
  it("does not fail either delivery when they contend for the shared fence", async () => {
    // Hold the first delivery inside `issues.create` — i.e. while it owns the
    // fence — until the second has had time to attempt and be refused. Without
    // this barrier the first could finish before the second starts, and the test
    // would pass without ever exercising contention.
    const holdFirst = deferred();
    let firstIsHoldingFence = false;
    const { ctx: ctxA, logger: loggerA } = mkCtx({
      onIssueCreate: async () => {
        firstIsHoldingFence = true;
        await holdFirst.promise;
      },
    });
    const { ctx: ctxB, logger: loggerB } = mkCtx();

    const a = deliver(
      ctxA,
      firingPayloadFor("staging-traffic-control", "traffic-ops-autorenew", "fp-a"),
      "req-a",
      fastPolicy(),
    );

    // Wait until A genuinely holds the fence before B attempts, so B's first
    // claim is guaranteed to be refused. Bounded: if A never reaches
    // issues.create (it threw earlier, or a future change stops routing
    // through it) this must report *that*, not hang to the vitest timeout and
    // surface as a timeout with the real defect invisible.
    const barrierDeadline = Date.now() + 5_000;
    while (!firstIsHoldingFence) {
      if (Date.now() > barrierDeadline) {
        throw new Error(
          "delivery A never reached issues.create, so it never held the fence; " +
            "the contention this test asserts was never set up",
        );
      }
      await new Promise((r) => setTimeout(r, 1));
    }

    const b = deliver(
      ctxB,
      firingPayloadFor("ssh-bastion", "teleport-session-sync", "fp-b"),
      "req-b",
      fastPolicy(),
    );

    // Let B contend and back off a few times, then release A.
    await new Promise((r) => setTimeout(r, 60));
    holdFirst.resolve();

    // The headline criterion: neither delivery fails.
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();

    // ...and B got there by WAITING, not by sailing through uncontended. This is
    // what fails if the bounded wait is removed: B would reject instead.
    const waited = loggerB.info.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes("was held by a concurrent delivery"));
    expect(waited).toHaveLength(1);
    expect(waited[0]).toContain("instead of failing the delivery");
    expect(loggerA.error).not.toHaveBeenCalled();
    expect(loggerB.error).not.toHaveBeenCalled();
  });

  it("leaves the fence released once both have finished", async () => {
    const { ctx: ctxA } = mkCtx();
    const { ctx: ctxB } = mkCtx();

    await deliver(
      ctxA,
      firingPayloadFor("staging-blockcastd", "cast-contract-guard", "fp-c"),
      "req-c",
      fastPolicy(),
    );
    await deliver(
      ctxB,
      firingPayloadFor("production-blockcastd", "relay-cache", "fp-d"),
      "req-d",
      fastPolicy(),
    );

    const rows = await db.query<{ phase: string; firing_token: string | null }>(
      `SELECT phase, firing_token FROM ${FENCES} WHERE company_id = $1`,
      [COMPANY_ID],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.phase).toBe("active");
    expect(rows.rows[0]?.firing_token).toBeNull();
  });
});

describe("PEN-3013 — a genuinely wedged fence still fails the delivery", () => {
  /**
   * The wait must not paper over a wedge. A fence held by this same process's
   * identity is never stolen (that exclusion is load-bearing for correctness),
   * so once the budget is spent the delivery must fail exactly as before —
   * same message, same operator escape hatch, still transient so Alertmanager
   * keeps retrying. Widening the taxonomy here is explicitly out of scope.
   */
  it("throws the unchanged held-phase error after the budget is exhausted", async () => {
    await db.query(
      `INSERT INTO ${FENCES}
         (company_id, aggregate_key, phase, firing_token, owner_instance_id, owner_slot)
       VALUES ($1, $2, 'firing', $3, $4, $5)`,
      [
        COMPANY_ID,
        `alert-aggregate:v1:["${ALERTNAME}",null]`,
        "token-held-by-live-sibling",
        SELF.instanceId,
        SELF.slot,
      ],
    );
    const { ctx, logger } = mkCtx();

    await expect(
      deliver(
        ctx,
        firingPayloadFor("ssh-bastion", "teleport-session-sync", "fp-wedged"),
        "req-wedged",
        fastPolicy(),
      ),
    ).rejects.toThrow(AlertDeliveryIncompleteError);

    const logged = logger.error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("is held in phase 'firing'");
    expect(logged).toContain("recover-aggregate-firing");
    // The holder's generation is untouched — waiting claims nothing.
    const rows = await db.query<{ firing_token: string | null }>(
      `SELECT firing_token FROM ${FENCES} WHERE company_id = $1`,
      [COMPANY_ID],
    );
    expect(rows.rows[0]?.firing_token).toBe("token-held-by-live-sibling");
  });

  it("stops at the budget rather than retrying forever", async () => {
    await db.query(
      `INSERT INTO ${FENCES}
         (company_id, aggregate_key, phase, firing_token, owner_instance_id, owner_slot)
       VALUES ($1, $2, 'firing', $3, $4, $5)`,
      [
        COMPANY_ID,
        `alert-aggregate:v1:["${ALERTNAME}",null]`,
        "token-held-by-live-sibling",
        SELF.instanceId,
        SELF.slot,
      ],
    );
    const { ctx } = mkCtx();

    // A virtual clock: no real sleeping, so this asserts the budget arithmetic
    // rather than wall-clock timing.
    let clock = 0;
    const slept: number[] = [];
    const policy = fastPolicy({
      budgetMs: 1_000,
      initialDelayMs: 10,
      maxDelayMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      random: () => 1,
    });

    await expect(
      deliver(
        ctx,
        firingPayloadFor("ssh-bastion", "teleport-session-sync", "fp-budget"),
        "req-budget",
        policy,
      ),
    ).rejects.toThrow(AlertDeliveryIncompleteError);

    expect(slept.length).toBeGreaterThan(1);
    // Never overruns the budget, including on the final attempt.
    expect(slept.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(1_000);
    // Backs off rather than hot-looping, and clamps at maxDelayMs.
    expect(Math.max(...slept)).toBeLessThanOrEqual(100);
    // Growth is asserted on the *unclamped prefix*, which is the only part that
    // expresses the backoff. With random() pinned to 1 the schedule is
    // deterministic: ceiling = min(maxDelayMs, initialDelayMs * 2**attempt).
    // Comparing first-to-last instead would pass on the size of the trailing
    // budget remainder — an assertion that holds even with the growth removed.
    expect(slept.slice(0, 4)).toEqual([10, 20, 40, 80]);
  });

  it("spends one budget per aggregate key for a whole batch, not one per alert", async () => {
    // The budget is taken per call, so without a per-delivery memo a batch of N
    // alerts costs N budgets against a fence nothing in this delivery can
    // clear. That lands on precisely the wrong population: Alertmanager groups
    // by alertname and the aggregate key is [alertname, dedupe-domain], so one
    // batch is exactly the set that maps to one fence.
    await db.query(
      `INSERT INTO ${FENCES}
         (company_id, aggregate_key, phase, firing_token, owner_instance_id, owner_slot)
       VALUES ($1, $2, 'firing', $3, $4, $5)`,
      [
        COMPANY_ID,
        `alert-aggregate:v1:["${ALERTNAME}",null]`,
        "token-held-by-live-sibling",
        SELF.instanceId,
        SELF.slot,
      ],
    );
    const { ctx } = mkCtx();

    let clock = 0;
    const slept: number[] = [];
    const policy = fastPolicy({
      budgetMs: 1_000,
      initialDelayMs: 10,
      maxDelayMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      random: () => 1,
    });

    const BATCH_SIZE = 10;
    const rejection = await deliver(
      ctx,
      firingBatchOf(BATCH_SIZE),
      "req-batch",
      policy,
    ).catch((err: unknown) => err);

    expect(rejection).toBeInstanceOf(AlertDeliveryIncompleteError);

    // The headline property: total waiting is bounded by ONE budget for the
    // whole batch. Without the memo this is ~10x over.
    expect(slept.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(1_000);

    // ...and the saving comes from alerts 2..N not waiting, not from the first
    // one being cut short: the first alert still spends a real budget.
    expect(slept.length).toBeGreaterThan(1);

    // Every alert is still reported failed, so the cheaper failure path costs
    // no coverage — nothing is silently dropped (BLO-20467).
    expect(
      (rejection as AlertDeliveryIncompleteError).fingerprints,
    ).toHaveLength(BATCH_SIZE);

    // The holder's generation is untouched throughout — waiting claims nothing.
    const rows = await db.query<{ firing_token: string | null }>(
      `SELECT firing_token FROM ${FENCES} WHERE company_id = $1`,
      [COMPANY_ID],
    );
    expect(rows.rows[0]?.firing_token).toBe("token-held-by-live-sibling");
  });

  it("jitters its delays so a restart fan-out does not re-collide in lockstep", async () => {
    await db.query(
      `INSERT INTO ${FENCES}
         (company_id, aggregate_key, phase, firing_token, owner_instance_id, owner_slot)
       VALUES ($1, $2, 'firing', $3, $4, $5)`,
      [
        COMPANY_ID,
        `alert-aggregate:v1:["${ALERTNAME}",null]`,
        "token-held-by-live-sibling",
        SELF.instanceId,
        SELF.slot,
      ],
    );
    const { ctx } = mkCtx();

    let clock = 0;
    const slept: number[] = [];
    // A fixed non-1 draw: with full jitter every delay must be scaled by it, so
    // an implementation that ignored `random` would produce different numbers.
    const policy = fastPolicy({
      budgetMs: 1_000,
      initialDelayMs: 10,
      maxDelayMs: 80,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      random: () => 0.5,
    });

    await expect(
      deliver(
        ctx,
        firingPayloadFor("ssh-bastion", "teleport-session-sync", "fp-jitter"),
        "req-jitter",
        policy,
      ),
    ).rejects.toThrow(AlertDeliveryIncompleteError);

    // Half of each ceiling: 5, 10, 20, 40, then clamped at 40 (80 * 0.5).
    expect(slept.slice(0, 4)).toEqual([5, 10, 20, 40]);
    expect(Math.max(...slept)).toBe(40);
  });
});
