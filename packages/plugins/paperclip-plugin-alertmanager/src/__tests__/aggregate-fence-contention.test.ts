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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  AlertDeliveryIncompleteError,
  type AggregateFenceWaitPolicy,
  handleWebhook,
  localFenceWaiterCount,
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

/**
 * `beforeExecute` is the seam the lost-reclaim case needs: it can suspend one
 * delivery's next write mid-flight so another delivery provably gets there
 * first. It is per-context, so arming it on one delivery leaves the others
 * running at full speed.
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

function mkCtx(
  overrides: {
    onIssueCreate?: () => Promise<void>;
    beforeExecute?: (sql: string) => Promise<void>;
  } = {},
) {
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
    db: realDb(db, { beforeExecute: overrides.beforeExecute }),
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

/**
 * Poll until `condition` holds, reporting `describeFailure` rather than hanging
 * to the vitest timeout.
 *
 * The deadline is a *diagnostic backstop*, not a correctness input: it exists so
 * a genuine regression names itself instead of surfacing as an opaque timeout.
 * Nothing this suite asserts may depend on the machine reaching a state within
 * a particular wall-clock span — that dependency is exactly what ejected merge
 * groups (PEN-3654), so the deadline is set far beyond any plausible CI stall.
 *
 * It must nonetheless stay strictly BELOW the enclosing test budget, or vitest
 * kills the case first and the named message below is unreachable — which would
 * reintroduce the opaque timeout this helper exists to remove. This package sets
 * `testTimeout: 60_000` (vitest.config.ts, BLO-37114).
 *
 * The two backstops in the contention case are NOT three sequential spans, and
 * reading them as one is how the margin gets mis-stated. The second backstop
 * (the `bRefusals >= 2 || bSettled` wait) runs entirely INSIDE delivery B's own
 * `budgetMs: 30_000`, because B is constructed before that wait begins. So the
 * worst case for a PASSING run is backstop #1 (15s) followed by B's budget
 * (30s, which subsumes backstop #2) = 45s, leaving ~15s inside the 60s case
 * budget. The naive 15 + 15 + 30 = 60 reads the nested span twice and so
 * reports zero headroom where there is 15s.
 *
 * Two invariants bound this default, and both are violated at 30s, not 25s:
 *   - 2 x timeoutMs < testTimeout, or backstop #2 is pre-empted and silent.
 *   - timeoutMs < B's budgetMs, or B can exhaust its budget and reject while A
 *     is still deliberately held, which is the very failure this case asserts
 *     against.
 * 15s satisfies both with 2x margin. Do not raise it without re-deriving these.
 */
async function waitUntil(
  condition: () => boolean,
  describeFailure: () => string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(describeFailure());
    // 10ms, matching the sibling helper in adapter-utils/src/server-utils.test.ts.
    // What this polls for is delivery B's real PGlite work on this same event
    // loop, so a 1ms self-reschedule (~1000x/s) competes with the thing it is
    // measuring — worst on the scheduling-starved ARC pod this change targets
    // (PEN-3528). B's backoff delays are 5-20ms, so 10ms is indistinguishable
    // for every condition asserted here and strictly cheaper.
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Built once per file rather than per test: the WASM Postgres boot plus the
 * migration replay cost ~1.6s each time and blew vitest's 10s hook timeout on a
 * saturated CI runner, reddening unrelated PRs (BLO-36739). Truncating gives
 * each case the same empty schema a fresh database did. The table list comes
 * from the catalog so a new migration cannot silently leak state between cases,
 * and covers the `public` FK stubs as well as the plugin namespace: nothing
 * seeds them today, but the `alert_escalation_covers` path cannot be exercised
 * without rows in them, and those rows would otherwise outlive the case that
 * wrote them. The CASCADE direction is safe either way — the namespace tables
 * reference `public`, never the reverse.
 */
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
    await waitUntil(
      () => firstIsHoldingFence,
      () =>
        "delivery A never reached issues.create, so it never held the fence; " +
        "the contention this test asserts was never set up",
    );

    // B's budget must not be able to expire while A is deliberately held. What
    // this case asserts is that a refused claim WAITS and then succeeds — not
    // how large the budget is, which is pinned on a virtual clock below.
    //
    // PEN-3654: the previous shape raced a 400ms wall-clock budget against A's
    // real PGlite work, then released A on a fixed 60ms sleep. Measured on an
    // IDLE 32-core box, B already consumed 46–202ms of that 400ms budget
    // (max 51%), so under CI contention — workspaces-b runs packages
    // concurrently on an ARC pod that PEN-3528 shows is scheduling-starved —
    // a ~2x stretch made B exhaust its budget and reject. A merge-group
    // ejection costs ~80 minutes of the whole organisation's merge throughput.
    let bRefusals = 0;
    const b = deliver(
      ctxB,
      firingPayloadFor("ssh-bastion", "teleport-session-sync", "fp-b"),
      "req-b",
      fastPolicy({
        budgetMs: 30_000,
        sleep: async (ms) => {
          bRefusals += 1;
          await new Promise((r) => setTimeout(r, ms));
        },
      }),
    );

    // Release A on OBSERVED contention rather than on elapsed time: the policy
    // only sleeps after a refused claim, so this is B being refused, not a
    // guess about how long that takes.
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

    // B cannot legitimately settle before A is released — A holds the fence
    // under this same process identity, so the steal and backstop arms both
    // exclude it. So a settled B here means the bounded wait is gone, which
    // must fail loudly and immediately rather than stalling this barrier.
    await waitUntil(
      () => bRefusals >= 2 || bSettled !== null,
      () =>
        `delivery B neither retried nor settled while A held the fence ` +
        `(refusals=${bRefusals})`,
    );
    expect(
      bSettled,
      `delivery B settled (${bSettled}) before ever retrying, so it did not ` +
        `wait out the held fence: ${String(bError)}`,
    ).toBeNull();

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

/**
 * PEN-3013 — the fence is a mutex between coroutines of ONE process, so a
 * release performed here can hand it over directly instead of letting the
 * waiter discover it on a poll.
 *
 * Why that is the whole population and not a subset: `beginAggregateFiring`
 * admits a same-slot holder with a different `owner_instance_id`, and admits
 * any holder past the abandonment backstop. The only holder it can still refuse
 * for is one sharing `WORKER_INSTANCE_ID` — a concurrent delivery in this same
 * worker child. Measured on `paperclip-0` over 24h to 2026-09-30: 902 refusals,
 * single pod, all phase `firing`.
 *
 * These cases pin the *mechanism*, not just the outcome. Each uses a poll
 * interval far longer than the test could tolerate, so completing at all proves
 * the waiter was woken by the release. Asserting only "B eventually succeeds"
 * would pass with the handoff deleted, because the pre-existing backoff already
 * gets there — slowly.
 */
describe("PEN-3013 — a local release hands the fence to the next waiter", () => {
  const AGG_KEY = `alert-aggregate:v1:["${ALERTNAME}",null]`;

  /**
   * A 5s first delay against a 30s budget. The pre-existing poll loop cannot
   * produce a completion inside the deadlines below; only a wake can.
   */
  const slowPollPolicy = (): AggregateFenceWaitPolicy =>
    fastPolicy({
      budgetMs: 30_000,
      initialDelayMs: 5_000,
      maxDelayMs: 5_000,
      random: () => 1,
    });

  /** Bounded barrier: fail naming the real condition rather than timing out. */
  async function awaitQueuedWaiters(
    count: number,
    what: string,
    budgetMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (localFenceWaiterCount(COMPANY_ID, AGG_KEY) < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `${what}: expected ${count} queued local waiter(s) on ${AGG_KEY}, ` +
            `saw ${localFenceWaiterCount(COMPANY_ID, AGG_KEY)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  async function awaitFenceHeld(what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const rows = await db.query<{ phase: string }>(
        `SELECT phase FROM ${FENCES} WHERE company_id = $1 AND aggregate_key = $2`,
        [COMPANY_ID, AGG_KEY],
      );
      if (rows.rows[0]?.phase === "firing") return;
      if (Date.now() > deadline) {
        throw new Error(`${what}: the fence was never held, so nothing contended`);
      }
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  it("wakes the waiter on release instead of leaving it to poll", async () => {
    const holdFirst = deferred();
    const { ctx: ctxA } = mkCtx({ onIssueCreate: async () => holdFirst.promise });
    const { ctx: ctxB, logger: loggerB } = mkCtx();

    const a = deliver(
      ctxA,
      firingPayloadFor("staging-traffic-control", "traffic-ops-autorenew", "fp-hoA"),
      "req-handoff-a",
      slowPollPolicy(),
    );
    await awaitFenceHeld("delivery A");

    const b = deliver(
      ctxB,
      firingPayloadFor("ssh-bastion", "teleport-session-sync", "fp-hoB"),
      "req-handoff-b",
      slowPollPolicy(),
    );
    // B must be parked on the local queue before A releases; otherwise the wake
    // lands on nobody and this would measure the poll it exists to replace.
    await awaitQueuedWaiters(1, "delivery B");

    const releasedAt = Date.now();
    holdFirst.resolve();
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
    const handoffMs = Date.now() - releasedAt;

    // The discriminating assertion. B's own timer could not have fired for
    // another ~5s, so finishing this quickly is only possible via the wake.
    expect(handoffMs).toBeLessThan(2_000);
    expect(loggerB.error).not.toHaveBeenCalled();
    // It still went through the wait path — it did not sail in uncontended.
    expect(
      loggerB.info.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes("was held by a concurrent delivery")),
    ).toHaveLength(1);
    // And the queue is drained, so a waiter cannot leak across deliveries.
    expect(localFenceWaiterCount(COMPANY_ID, AGG_KEY)).toBe(0);
  });

  it("hands over in arrival order, one waiter per release", async () => {
    // Waking all waiters would rebuild the thundering herd the jitter exists to
    // break up. With a poll interval far longer than this test, the only way a
    // delivery can finish is by being woken — so the completion ORDER is
    // evidence of who was handed the fence, in what order, and that a single
    // release did not wake both.
    const holdFirst = deferred();
    const { ctx: ctxA } = mkCtx({ onIssueCreate: async () => holdFirst.promise });
    const { ctx: ctxB } = mkCtx();
    const { ctx: ctxC } = mkCtx();
    const completed: string[] = [];

    const a = deliver(
      ctxA,
      firingPayloadFor("staging-traffic-control", "traffic-ops-autorenew", "fp-fifoA"),
      "req-fifo-a",
      slowPollPolicy(),
    ).then(() => void completed.push("a"));
    await awaitFenceHeld("delivery A");

    const b = deliver(
      ctxB,
      firingPayloadFor("ssh-bastion", "teleport-session-sync", "fp-fifoB"),
      "req-fifo-b",
      slowPollPolicy(),
    ).then(() => void completed.push("b"));
    await awaitQueuedWaiters(1, "delivery B");

    // Only started once B is definitely queued, so arrival order is B then C
    // rather than whichever promise the event loop happened to advance first.
    const c = deliver(
      ctxC,
      firingPayloadFor("staging-blockcastd", "cast-contract-guard", "fp-fifoC"),
      "req-fifo-c",
      slowPollPolicy(),
    ).then(() => void completed.push("c"));
    await awaitQueuedWaiters(2, "delivery C");

    holdFirst.resolve();
    await Promise.all([a, b, c]);

    // A finishes first by construction; the assertion is that B — which queued
    // first — is served before C. If one release woke both, C could overtake.
    expect(completed).toEqual(["a", "b", "c"]);
    expect(localFenceWaiterCount(COMPANY_ID, AGG_KEY)).toBe(0);
  });

  it("still fails at the budget when no local release ever comes, and deregisters", async () => {
    // The worst case must be exactly what it was before: a fence this process
    // cannot release is unaffected by a mechanism that only fires on release.
    // This is the case the handoff must NOT paper over — it is what keeps the
    // wedged-fence taxonomy (and its 502 + Alertmanager retry) intact.
    await db.query(
      `INSERT INTO ${FENCES}
         (company_id, aggregate_key, phase, firing_token, owner_instance_id, owner_slot)
       VALUES ($1, $2, 'firing', $3, $4, $5)`,
      [COMPANY_ID, AGG_KEY, "token-held-by-live-sibling", SELF.instanceId, SELF.slot],
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

    await expect(
      deliver(
        ctx,
        firingPayloadFor("ssh-bastion", "teleport-session-sync", "fp-nowake"),
        "req-nowake",
        policy,
      ),
    ).rejects.toThrow(AlertDeliveryIncompleteError);

    // Unchanged backoff schedule, unchanged budget ceiling.
    expect(slept.slice(0, 4)).toEqual([10, 20, 40, 80]);
    expect(slept.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(1_000);
    // A waiter that gave up must not stay queued, or the next release would
    // hand the fence to a delivery that has already returned.
    expect(localFenceWaiterCount(COMPANY_ID, AGG_KEY)).toBe(0);
  });

  it("keeps its place in the queue when a fresh delivery wins the post-wake race", async () => {
    // A wake is not a grant: `signalLocalFenceRelease` dequeues the waiter, but
    // ownership is still decided by the claim UPDATE, and a delivery that
    // arrives in between attempts a claim once BEFORE it registers. If the
    // woken waiter is not put back, it has consumed the wake and left the
    // queue, so no later release can reach it — the starvation this suite
    // exists to remove, landing on the longest-waiting delivery.
    //
    // The race is made deterministic rather than hoped for: B's next write is
    // suspended mid-flight, C claims the now-free fence while B is held there,
    // and only then is B allowed to proceed into a claim that must fail.
    const holdA = deferred();
    const holdC = deferred();
    const { ctx: ctxA } = mkCtx({ onIssueCreate: async () => holdA.promise });

    let armed = false;
    const bReachedClaim = deferred();
    const releaseBClaim = deferred();
    let interceptedSql = "";
    const { ctx: ctxB } = mkCtx({
      beforeExecute: async (sql) => {
        if (!armed) return;
        armed = false; // once: only the post-wake reclaim is suspended
        interceptedSql = sql;
        bReachedClaim.resolve();
        await releaseBClaim.promise;
      },
    });
    const { ctx: ctxC } = mkCtx({ onIssueCreate: async () => holdC.promise });

    const a = deliver(
      ctxA,
      firingPayloadFor("staging-traffic-control", "traffic-ops-autorenew", "fp-lostA"),
      "req-lost-a",
      slowPollPolicy(),
    );
    await awaitFenceHeld("delivery A");

    const b = deliver(
      ctxB,
      firingPayloadFor("ssh-bastion", "teleport-session-sync", "fp-lostB"),
      "req-lost-b",
      slowPollPolicy(),
    );
    await awaitQueuedWaiters(1, "delivery B");

    // Arm only now, so the hook cannot catch B's pre-registration attempt.
    armed = true;
    holdA.resolve();
    await a;
    // B has been woken and is suspended inside its reclaim.
    await bReachedClaim.promise;
    // The seam is self-verifying: assert we really suspended the fence claim
    // and not some unrelated write that happened to be next.
    expect(interceptedSql).toContain("alertmanager_aggregate_lifecycle_fences");
    expect(interceptedSql).toContain("'firing'");
    expect(localFenceWaiterCount(COMPANY_ID, AGG_KEY)).toBe(0);

    // C arrives fresh and unqueued, and takes the fence B was just handed.
    const c = deliver(
      ctxC,
      firingPayloadFor("staging-blockcastd", "cast-contract-guard", "fp-lostC"),
      "req-lost-c",
      slowPollPolicy(),
    );
    await awaitFenceHeld("delivery C");

    // Now let B's doomed claim land.
    releaseBClaim.resolve();

    // THE ASSERTION. B lost the race it was woken for. It must be back on the
    // queue — at the front, since nothing else is waiting — or C's release
    // below reaches nobody. Without the re-queue this stays 0 forever.
    //
    // Deliberately bounded well under the 5s poll interval: a re-queue happens
    // immediately after the failed claim, so 2s is generous for the real
    // behaviour while still beating the fallback poll, which keeps the failure
    // this barrier's named error rather than an undiagnostic test timeout.
    await awaitQueuedWaiters(1, "delivery B after losing the reclaim race", 2_000);

    const releasedAt = Date.now();
    holdC.resolve();
    await expect(c).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();

    // B's own timer could not fire for another ~5s, so finishing this quickly
    // proves C's release reached B through the queue it was put back on.
    expect(Date.now() - releasedAt).toBeLessThan(2_000);
    expect(localFenceWaiterCount(COMPANY_ID, AGG_KEY)).toBe(0);
    // Generous relative to the ~2s happy path, so that when this regresses the
    // bounded barriers above report WHICH condition failed instead of vitest
    // reporting only that the case ran long.
  }, 20_000);
});
