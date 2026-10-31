/**
 * PEN-4405 — the third 502 arm: a resolution delivery refused by its OWN
 * aggregate's fence.
 *
 * The aggregate fence produces 502s on three arms, and only two were owned:
 *
 *   1. N-subject contention — `is held in phase '<phase>' by a delivery in
 *      progress`. Distinct subjects serialise on one shared key. Fixed by
 *      PEN-3013 (bounded wait) and PEN-4110 (per-subject keys).
 *   2. Delivery-budget exhaustion — `delivery budget 90000ms exhausted after
 *      N of M alerts`. PEN-4100.
 *   3. **This one** — `is already finalizing; retrying resolution delivery`.
 *
 * Arm 3 is not arm 1 with a different message, and splitting the key cannot
 * reach it. Measured on 2026-10-18 on `paperclip-0`: 139 refusals over 44m38s,
 * **one** fingerprint (`25520b282d938a24`), **one** aggregate key
 * (`alert-aggregate:v1:["PaperclipProductionDeployFailing",null]`), against
 * **zero** `is held in phase` lines and **zero** budget lines that day — 4.55%
 * of the day's deliveries (139/3054). The alert is `and on()`-chained and emits
 * exactly one series, so there is only one subject: it was colliding with
 * itself.
 *
 * The mechanism is an asymmetry between the two claims on one fence:
 *
 *   | | firing claim | finalization claim (before this fix) |
 *   |---|---|---|
 *   | admits | `active`, `finalizing` | `active` only |
 *   | steals from a dead same-slot owner | yes | no |
 *   | steals past the 15m backstop | yes | no |
 *   | waits for a live holder | yes, 3s + FIFO handoff | **no — one attempt** |
 *   | names the blocking phase | yes, read back | **no — fixed string** |
 *   | emits a metric | yes (BLO-32113) | **no** |
 *
 * So a resolution lost to any concurrent delivery on its own aggregate,
 * including the sub-second firing delivery the firing side absorbs silently,
 * and Alertmanager retried the 502 into the same collision.
 *
 * These cases run the **real fence SQL** against a real PostgreSQL (PGlite,
 * in-process WASM) with the schema built from this plugin's actual migration
 * files — the same approach, and for the same reason, as
 * `aggregate-fence-contention.test.ts`: a hand-written model of the fence would
 * pass with the fix removed.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  type AggregateFenceWaitPolicy,
  handleWebhook,
} from "../webhook-handler.js";
import { DEFAULT_ISSUE_ROUTE_MAP } from "../constants.js";
import type {
  AlertmanagerPluginConfig,
  AlertmanagerWebhookPayload,
} from "../types.js";

/** Hardcoded in the migration files, so the test schema must match. */
const NAMESPACE = "plugin_alertmanager_184163d1ba";
const FENCES = `${NAMESPACE}.alertmanager_aggregate_lifecycle_fences`;
const MEMBERS = `${NAMESPACE}.alertmanager_aggregate_members`;
const COMPANY_ID = "company-1";
/** The single-series alertname from the 2026-10-18 evidence. */
const ALERTNAME = "PaperclipProductionDeployFailing";
const AGGREGATE_KEY = `alert-aggregate:v1:["${ALERTNAME}",null]`;
/** The single fingerprint from that burst. */
const FINGERPRINT = "25520b282d938a24";
/** A real UUID: the cover cascade casts `issue_id` to `uuid`, so `issue-1` throws. */
const ISSUE_ID = "6f1c2b7a-3d4e-4f50-9a1b-2c3d4e5f6071";

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

const baseConfig = (): AlertmanagerPluginConfig => ({
  webhookToken: "token",
  defaultCompanyId: COMPANY_ID,
  autoCloseOnResolve: true,
  issueRouteMap: DEFAULT_ISSUE_ROUTE_MAP,
  fallbackAgentName: "Alert Fallback",
});

const alertFor = (status: "firing" | "resolved", fingerprint = FINGERPRINT) => ({
  status,
  fingerprint,
  labels: { alertname: ALERTNAME, severity: "critical" },
  annotations: { summary: "production deploy is failing" },
  startsAt: "2026-10-18T13:30:00Z",
  endsAt: status === "resolved" ? "2026-10-18T13:45:00Z" : "0001-01-01T00:00:00Z",
  generatorURL: "http://prometheus/graph",
});

const payload = (
  status: "firing" | "resolved",
  alerts = [alertFor(status)],
): AlertmanagerWebhookPayload => ({
  version: "4",
  status,
  receiver: "paperclip",
  groupLabels: { alertname: ALERTNAME },
  commonLabels: { alertname: ALERTNAME, severity: "critical" },
  commonAnnotations: {},
  externalURL: "http://alertmanager.monitoring.svc:9093",
  alerts: alerts as never,
});

/**
 * One state store shared across the contexts in a case, because the production
 * shape is several concurrent deliveries of the SAME fingerprint hitting one
 * worker. A per-context store would make each delivery read `null` and take the
 * unknown-fingerprint drop, which never reaches the fence at all.
 */
type SharedState = Map<string, unknown>;

/**
 * `beforeExecute` is the seam the member-reattach case needs: it can land a write
 * in the window between `resolveAggregateMember`'s sibling SELECT and the claim
 * UPDATE, which is the only way that race is reachable. Same seam, same reason,
 * as the sibling file's lost-reclaim case.
 */
function realDb(
  pg: PGlite,
  hooks: { beforeExecute?: (sql: string) => Promise<void> } = {},
) {
  return {
    namespace: NAMESPACE,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const result = await pg.query(sql, params as unknown[]);
      return result.rows;
    }),
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      await hooks.beforeExecute?.(sql);
      const result = await pg.query(sql, params as unknown[]);
      return { rowCount: result.affectedRows ?? 0 };
    }),
  };
}

function mkCtx(
  store: SharedState,
  overrides: {
    issueStatus?: string;
    onIssueUpdate?: () => Promise<void>;
    beforeExecute?: (sql: string) => Promise<void>;
  } = {},
) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
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
      get: vi.fn(async () => ({
        id: ISSUE_ID,
        status: overrides.issueStatus ?? "todo",
      })),
      create: vi.fn(async () => ({ id: ISSUE_ID })),
      update: vi.fn(async () => {
        await overrides.onIssueUpdate?.();
        return { id: ISSUE_ID };
      }),
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async () => ({ id: "comment-1" })),
    },
    db: realDb(db, { beforeExecute: overrides.beforeExecute }),
    events: { emit: vi.fn(async (..._args: unknown[]) => {}) },
    metrics: { write: vi.fn(async (..._args: unknown[]) => {}), observe: vi.fn(async (..._args: unknown[]) => {}) },
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
  body: AlertmanagerWebhookPayload,
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
      rawBody: JSON.stringify(body),
      parsedBody: body,
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

/** See the sibling helper in `aggregate-fence-contention.test.ts` for the full
 * rationale: this is a diagnostic backstop, not a correctness input, and is set
 * far beyond any plausible CI stall while staying below `testTimeout`. */
async function waitUntil(
  condition: () => boolean,
  describeFailure: () => string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(describeFailure());
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Seed the aggregate as a single firing member on one issue — the state the
 * 10-18 burst's resolution deliveries arrived into. */
async function seedSingleMemberAggregate(store: SharedState): Promise<void> {
  const { ctx } = mkCtx(store);
  await expect(deliver(ctx, payload("firing"), "req-seed", fastPolicy())).resolves.toEqual({
    accepted: 1,
  });
  const fence = await db.query<{ phase: string }>(
    `SELECT phase FROM ${FENCES} WHERE company_id = $1 AND aggregate_key = $2`,
    [COMPANY_ID, AGGREGATE_KEY],
  );
  expect(fence.rows[0]?.phase, "the seeding firing delivery must leave the fence released").toBe(
    "active",
  );
}

let truncateAll: string;

beforeAll(async () => {
  db = new PGlite();
  await applyMigrations(db);
  const tables = await db.query<{ qualified: string }>(
    `SELECT format('%I.%I', schemaname, tablename) AS qualified
       FROM pg_tables WHERE schemaname = ANY($1)`,
    [[NAMESPACE, "public"]],
  );
  expect(tables.rows.length).toBeGreaterThan(0);
  truncateAll = `TRUNCATE ${tables.rows
    .map((r) => r.qualified)
    .join(", ")} RESTART IDENTITY CASCADE`;
}, 30_000);

beforeEach(async () => {
  await db.query(truncateAll);
});

afterAll(async () => {
  await db.close();
});

describe("PEN-4405 — a resolution refused by its own aggregate", () => {
  it("replays 2026-10-18: a second resolution delivery for the SAME fingerprint waits instead of 502ing", async () => {
    // The production shape exactly: one fingerprint, one aggregate key, and
    // Alertmanager retrying a resolution into the delivery still finalizing it.
    const store: SharedState = new Map();
    await seedSingleMemberAggregate(store);

    // Hold delivery A inside `issues.update` — i.e. while it owns the fence in
    // phase `cancelling` — until B has been refused at least twice. Without this
    // barrier A could finish before B starts and the test would pass with the
    // fix removed.
    const holdA = deferred();
    let aIsHoldingFence = false;
    const { ctx: ctxA, logger: loggerA } = mkCtx(store, {
      onIssueUpdate: async () => {
        aIsHoldingFence = true;
        await holdA.promise;
      },
    });
    const { ctx: ctxB, logger: loggerB, mocks: mocksB } = mkCtx(store);

    const a = deliver(ctxA, payload("resolved"), "req-a", fastPolicy());
    await waitUntil(
      () => aIsHoldingFence,
      () =>
        "delivery A never reached issues.update, so it never held the fence; " +
        "the finalize/resolve collision this test asserts was never set up",
    );

    // B's budget must not be able to expire while A is deliberately held: what
    // this asserts is that a refused finalization WAITS and then succeeds, not
    // how large the budget is. See PEN-3654 on the sibling case for why a short
    // wall-clock budget raced against real PGlite work ejects merge groups.
    let bRefusals = 0;
    const b = deliver(
      ctxB,
      payload("resolved"),
      "req-b",
      fastPolicy({
        budgetMs: 30_000,
        sleep: async (ms) => {
          bRefusals += 1;
          await new Promise((r) => setTimeout(r, ms));
        },
      }),
    );

    let bSettled: "resolved" | "rejected" | null = null;
    let bError: unknown;
    void b.then(
      () => {
        bSettled = "resolved";
      },
      (err: unknown) => {
        bSettled = "rejected";
        bError = err;
      },
    );

    await waitUntil(
      () => bRefusals >= 2 || bSettled !== null,
      () =>
        `delivery B neither retried nor settled while A held the fence ` +
        `(refusals=${bRefusals})`,
    );
    expect(
      bSettled,
      `delivery B settled (${bSettled}) before ever retrying, so it did not wait ` +
        `out the in-flight finalization — this is the pre-fix behaviour that ` +
        `produced 139 refusals in 44m38s on 2026-10-18: ${String(bError)}`,
    ).toBeNull();

    holdA.resolve();

    // The headline criterion: neither delivery fails. Before the fix B rejected
    // on its first refusal, the host answered 502, and Alertmanager retried into
    // the same collision.
    await expect(a).resolves.toEqual({ accepted: 1 });
    await expect(b).resolves.toEqual({ accepted: 1 });

    // ...and B got there by WAITING, not by sailing through uncontended.
    const waited = loggerB.info.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes("was held by a concurrent delivery"));
    expect(waited).toHaveLength(1);
    expect(waited[0]).toContain("claimed finalization after");
    expect(loggerA.error).not.toHaveBeenCalled();
    expect(loggerB.error).not.toHaveBeenCalled();

    // No blocked-finalization metric: this collision was absorbed, so it must
    // not show up in the series that exists to count unabsorbed ones.
    expect(
      mocksB.metrics.write.mock.calls.map((c) => String(c[0])),
    ).not.toContain("alertmanager.aggregate.finalization_blocked");

    // And the fence is left released, not wedged in `finalizing` — the state
    // that refuses every later resolution until a worker restart.
    const rows = await db.query<{ phase: string; resolution_token: string | null }>(
      `SELECT phase, resolution_token FROM ${FENCES} WHERE company_id = $1`,
      [COMPANY_ID],
    );
    expect(rows.rows).toEqual([{ phase: "active", resolution_token: null }]);
  });

  it("names the phase that actually blocked, instead of asserting 'already finalizing'", async () => {
    // The 10-18 burst reported `is already finalizing` 138 times on a day when
    // ZERO firing claims were refused — which is what `firing` stealing from
    // `finalizing` looks like from the resolve side. The message was a fixed
    // string covering three phases, the same defect `beginAggregateFiring` was
    // fixed for after it sent a six-day investigation (PEN-2581) after the one
    // phase that could not have produced the failure.
    const store: SharedState = new Map();
    await seedSingleMemberAggregate(store);

    // Hold the fence in `firing` under a FOREIGN slot and instance, so neither
    // the identity steal nor the 15m backstop can release it: the refusal is
    // then guaranteed and the phase is unambiguous.
    await db.query(
      `UPDATE ${FENCES}
          SET phase = 'firing', firing_token = $3,
              owner_instance_id = 'other-instance', owner_slot = 'other-slot',
              updated_at = now()
        WHERE company_id = $1 AND aggregate_key = $2`,
      [COMPANY_ID, AGGREGATE_KEY, "foreign-firing-token"],
    );

    const { ctx, logger, mocks } = mkCtx(store);
    // `handleWebhook` wraps per-alert failures in `AlertDeliveryIncompleteError`,
    // so the per-alert message is read from the log line — which is also exactly
    // the Loki line the 2026-10-18 evidence was counted from.
    await expect(
      deliver(ctx, payload("resolved"), "req-blocked", fastPolicy({ budgetMs: 60 })),
    ).rejects.toThrow(/could not be processed/);
    const refusal = logger.error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(refusal).toContain("finalization is held in phase 'firing'");
    expect(
      refusal,
      "the fixed-string phase is the PEN-2581 defect, re-made on the resolve path",
    ).not.toContain("is already finalizing");

    // The metric this arm never had. Without it, six weeks of 502 investigation
    // (PEN-2988) had no series that could show this arm moving while the firing
    // arm sat flat, so it was folded into the firing arm's family.
    const blocked = mocks.metrics.write.mock.calls.filter(
      (c) => c[0] === "alertmanager.aggregate.finalization_blocked",
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0][2]).toMatchObject({
      alertname: ALERTNAME,
      aggregate_key: AGGREGATE_KEY,
      phase: "firing",
    });
    expect(
      mocks.metrics.write.mock.calls.map((c) => String(c[0])),
    ).toContain("alertmanager.aggregate.finalization_blocked_age_s");
  });

  it("does not spend the wait budget when a live member re-attached rather than a fence being held", async () => {
    // The claim has two predicates and only one of them is a fence. An
    // unresolved member means the aggregate is no longer last-member-resolved,
    // so there is nothing to wait for — waiting would spend a budget to
    // re-derive the same answer, and on a batch that cost is multiplied.
    const store: SharedState = new Map();
    await seedSingleMemberAggregate(store);

    // The race is only reachable in the window between `resolveAggregateMember`'s
    // sibling SELECT (which found none) and the claim UPDATE: a firing delivery
    // attaching a member any earlier is caught by that SELECT and takes the
    // ordinary `has-unresolved-siblings` path. So land it exactly there.
    let reattached = false;
    const attachOnClaim = async (sql: string) => {
      if (reattached || !/SET phase = 'finalizing'/.test(sql)) return;
      reattached = true;
      await db.query(
        `INSERT INTO ${MEMBERS} (company_id, aggregate_key, fingerprint, issue_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, aggregate_key, fingerprint)
         DO UPDATE SET resolved_at = NULL`,
        [COMPANY_ID, AGGREGATE_KEY, "sibling-still-firing", ISSUE_ID],
      );
    };

    const { ctx, logger } = mkCtx(store, { beforeExecute: attachOnClaim });
    let sleeps = 0;
    await expect(
      deliver(
        ctx,
        payload("resolved"),
        "req-reattached",
        fastPolicy({
          budgetMs: 30_000,
          sleep: async (ms) => {
            sleeps += 1;
            await new Promise((r) => setTimeout(r, ms));
          },
        }),
      ),
    ).rejects.toThrow(/could not be processed/);
    expect(reattached, "the claim UPDATE never ran, so the race was never set up").toBe(true);
    expect(logger.error.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "re-attached a live member",
    );
    expect(
      sleeps,
      "a re-attached member is not contention, so the wait budget must not be spent on it",
    ).toBe(0);
  });

  it("spends at most one wait budget per aggregate key per delivery, shared with the firing path", async () => {
    // A mixed batch is the realistic Alertmanager shape, and the budget is
    // per-call: without a shared memo a wedged fence would cost one full budget
    // per alert and eat into the 90s delivery budget that is itself a separate
    // 502 arm (PEN-4100).
    const store: SharedState = new Map();
    await seedSingleMemberAggregate(store);

    await db.query(
      `UPDATE ${FENCES}
          SET phase = 'firing', firing_token = $3,
              owner_instance_id = 'other-instance', owner_slot = 'other-slot',
              updated_at = now()
        WHERE company_id = $1 AND aggregate_key = $2`,
      [COMPANY_ID, AGGREGATE_KEY, "foreign-firing-token"],
    );

    // Virtual clock: `sleep` advances fake time instead of waiting, and jitter
    // is pinned, so one budget admits a fixed number of sleeps however slow the
    // DB round-trips are. Counting sleeps inside a wall-clock budget was not a
    // stable proxy for budgets spent (BLO-48051).
    const virtualPolicy = (onSleep: () => void) => {
      let t = 0;
      return fastPolicy({
        budgetMs: 60,
        now: () => t,
        random: () => 1,
        sleep: async (ms) => {
          onSleep();
          t += ms;
          await new Promise((r) => setImmediate(r));
        },
      });
    };

    const { ctx } = mkCtx(store);
    let batchSleeps = 0;
    await expect(
      deliver(
        ctx,
        {
          ...payload("firing", [
            alertFor("firing", "fp-other"),
            alertFor("resolved", FINGERPRINT),
          ]),
          status: "firing",
        },
        "req-memo",
        virtualPolicy(() => {
          batchSleeps += 1;
        }),
      ),
    ).rejects.toThrow();

    // The firing alert spends the budget and marks the key; the resolved alert
    // that follows gets one attempt and no wait. So the delivery slept for ONE
    // budget, not two — which is only observable because the memo is shared
    // across the two claim paths rather than private to each.
    const { ctx: soloCtx, logger: soloLogger } = mkCtx(store);
    let soloSleeps = 0;
    await expect(
      deliver(
        soloCtx,
        payload("resolved"),
        "req-memo-solo",
        virtualPolicy(() => {
          soloSleeps += 1;
        }),
      ),
    ).rejects.toThrow(/could not be processed/);
    expect(soloLogger.error.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "finalization is held in phase 'firing'",
    );

    expect(soloSleeps).toBeGreaterThan(0);
    expect(
      batchSleeps,
      `a two-alert batch against one wedged key slept ${batchSleeps} times, versus ` +
        `${soloSleeps} for a single alert spending one budget alone; the shared ` +
        `wedged memo must keep the batch at exactly one budget, not two`,
    ).toBe(soloSleeps);
  });
});

describe("BLO-49264 — a resolution reclaims a fence held past the abandonment backstop", () => {
  // 2026-10-25: `HeartbeatRunQueueAgentOldestQueuedHigh` sat in 'cancelling'
  // for ~2h, 288 resolution retries refused, then Alertmanager gave up. The
  // firing claim has had this backstop since BLO-32113, but a resolved alert
  // sends no firing delivery, so only the resolution claim can reach it.
  const holdFence = (phase: string, ageMinutes: number) =>
    db.query(
      `UPDATE ${FENCES}
          SET phase = $3, resolution_token = 'leaked-resolution-token',
              owner_instance_id = 'other-instance', owner_slot = 'other-slot',
              updated_at = now() - ($4::int * interval '1 minute')
        WHERE company_id = $1 AND aggregate_key = $2`,
      [COMPANY_ID, AGGREGATE_KEY, phase, ageMinutes],
    );

  it.each(["cancelling", "finalizing", "firing"])(
    "reclaims a foreign '%s' fence held past the backstop and finishes the resolution",
    async (phase) => {
      const store: SharedState = new Map();
      await seedSingleMemberAggregate(store);
      await holdFence(phase, 20);

      const { ctx, logger } = mkCtx(store);
      await expect(
        deliver(ctx, payload("resolved"), "req-stale", fastPolicy({ budgetMs: 60 })),
      ).resolves.toEqual({ accepted: 1 });
      expect(logger.error).not.toHaveBeenCalled();

      const rows = await db.query<{ phase: string; resolution_token: string | null }>(
        `SELECT phase, resolution_token FROM ${FENCES} WHERE company_id = $1`,
        [COMPANY_ID],
      );
      expect(rows.rows).toEqual([{ phase: "active", resolution_token: null }]);
    },
  );

  it("still refuses the same fence one minute inside the backstop", async () => {
    const store: SharedState = new Map();
    await seedSingleMemberAggregate(store);
    await holdFence("cancelling", 14);

    const { ctx, logger } = mkCtx(store);
    await expect(
      deliver(ctx, payload("resolved"), "req-fresh", fastPolicy({ budgetMs: 60 })),
    ).rejects.toThrow(/could not be processed/);
    expect(logger.error.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "finalization is held in phase 'cancelling'",
    );
  });
});
