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
      // Rest-typed so `.mock.calls[n]` is a real argument list: the tail-fencing
      // assertions below read the third argument, which a bare `async () => {}`
      // would type as an empty tuple.
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
      create: vi.fn(async () => ({ id: "issue-1" })),
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

/**
 * The steal in `beginAggregateFiring` rests on same-slot/different-instance,
 * which is strong evidence that the predecessor is gone but not proof: force
 * deletion and `podManagementPolicy: Parallel` both suspend the StatefulSet
 * at-most-one guarantee, and a partitioned node can leave an old process alive
 * and still able to do work.
 *
 * So safety must not depend on the predecessor being dead. `firing_token` is a
 * fresh UUID per claim, replaced on every steal — a generation — and the writes
 * the fence exists to protect are gated on it. These cases model a genuinely
 * overlapping predecessor: one still running, mid-delivery, when a replacement
 * takes the fence. It must lose deterministically.
 */
describe("BLO-31036 — an overlapping predecessor cannot write behind the new fence owner", () => {
  /** Steal the fence out from under the in-flight delivery, as a replacement process would. */
  function stealFenceOnClaim(mocks: ReturnType<typeof mkCtx>["mocks"]) {
    const passthrough = mocks.db.execute.getMockImplementation()!;
    let stolen = false;
    mocks.db.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const result = await passthrough(sql, params);
      if (!stolen && sql.includes(FENCES) && sql.includes("INSERT INTO")) {
        stolen = true;
        await db.query(
          `UPDATE ${FENCES}
              SET firing_token = $1, owner_instance_id = $2, owner_slot = $3
            WHERE company_id = $4 AND aggregate_key = $5`,
          ["token-replacement", "instance-replacement", SELF.slot, COMPANY_ID, AGGREGATE_KEY],
        );
      }
      return result;
    });
  }

  it("refuses the predecessor's member write once its generation is superseded", async () => {
    const { ctx, mocks } = mkCtx();
    stealFenceOnClaim(mocks);

    // The delivery must fail rather than attach a member behind the new owner.
    await expect(deliver(ctx)).rejects.toThrow();

    const members = await db.query(
      `SELECT fingerprint FROM ${NAMESPACE}.alertmanager_aggregate_members
        WHERE company_id = $1 AND aggregate_key = $2`,
      [COMPANY_ID, AGGREGATE_KEY],
    );
    expect(members.rows).toHaveLength(0);
  });

  it("cannot release or overwrite the replacement's fence on its way out", async () => {
    // Regression lock on behaviour that already held: `finishAggregateFiring`
    // was token-guarded before this change, so this case still passes with the
    // new member-write guard mutated out. It is kept because it pins the other
    // half of the property Ally asked about — a displaced predecessor must not
    // be able to clear or steal back the fence — not because it covers the fix.
    const { ctx, mocks } = mkCtx();
    stealFenceOnClaim(mocks);

    await expect(deliver(ctx)).rejects.toThrow();

    // The replacement still holds the fence under its own generation: the
    // predecessor's `finally` could not clear it, and nothing downgraded it.
    const fence = await readFence();
    expect(fence?.phase).toBe("firing");
    expect(fence?.firing_token).toBe("token-replacement");
    expect(fence?.owner_instance_id).toBe("instance-replacement");
  });

  // The member write is the *last* aggregate side effect in a delivery. Gating
  // only that one still let a displaced predecessor run every side effect ahead
  // of it and merely fail afterwards — the issue was already mutated. These two
  // cases assert the property the guard actually has to have: a predecessor
  // that has lost the generation performs NO aggregate side effect at all.
  it("files no issue, state, or event when displaced before creating one", async () => {
    const { ctx, mocks } = mkCtx();
    stealFenceOnClaim(mocks);

    await expect(deliver(ctx)).rejects.toThrow();

    // Without the barrier the predecessor created a real issue for an aggregate
    // it no longer owned, then lost the race at the member write — leaving an
    // orphan no member row and no resolver ever refers to.
    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.state.set).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();
  });

  it("does not resurrect a cancelled issue when displaced mid re-fire", async () => {
    const { ctx, mocks } = mkCtx();
    // The re-fire path, at its most damaging: the plugin had already resolved
    // this fingerprint and cancelled its issue, so `decideRefire` returns
    // `reopen`/`plugin_resolved` and the delivery would set it back to `todo`.
    // A predecessor doing that after a resolver finished the terminal
    // transition reopens an aggregate nothing will ever close again.
    mocks.state.get.mockResolvedValue({
      paperclipIssueId: "issue-cancelled",
      paperclipCompanyId: COMPANY_ID,
      aggregateKey: AGGREGATE_KEY,
      assigneeUserId: null,
      assigneeAgentId: "agent-fallback",
      alertname: ALERTNAME,
      severity: "critical",
      firstSeenAt: "2026-08-31T00:00:00Z",
      lastFiredAt: "2026-08-31T00:00:00Z",
      resolvedAt: "2026-08-31T01:00:00Z",
      operatorSuppressedAt: null,
      nextEscalationAt: null,
      escalationAttempt: 0,
      escalationComplete: true,
      escalationIntervalMs: null,
    } as never);
    mocks.issues.get.mockResolvedValue({
      id: "issue-cancelled",
      status: "cancelled",
    } as never);
    stealFenceOnClaim(mocks);

    await expect(deliver(ctx)).rejects.toThrow();

    // No status flip, no description rewrite, no re-open comment, and the
    // delivery banks nothing about a decision it was not entitled to apply.
    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(mocks.issues.createComment).not.toHaveBeenCalled();
    expect(mocks.state.set).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();

    // And it stopped at the barrier specifically, asserted on the reachability
    // boundary rather than on error text: the delivery got far enough to read
    // the issue and decide `reopen`, and then performed none of that decision.
    // Without the barrier this exact fixture reaches `issues.update` — the
    // aggregate has no members, so the rebind lookup finds no winner and the
    // else-branch reopens `issue-cancelled` outright.
    //
    // Error text is deliberately not asserted: the `finally` runs
    // `finishAggregateFiring`, which also fails once the token is gone, and a
    // throwing `finally` discards the in-flight exception. The surviving
    // message ("fence was lost ... retrying delivery") is still true and still
    // fails the delivery, so this is a diagnosability wrinkle rather than a
    // correctness one — but it means no test here can pin the barrier by name.
    expect(mocks.issues.get).toHaveBeenCalled();
  });
});

/**
 * BLO-31049 — the barrier is a fast path; the authoritative check is the host's.
 *
 * `assertFiringGeneration` can only prove ownership at the instant it runs, so
 * a steal landing between it and an in-flight `issues.*` RPC was not caught.
 * Every mutating call now also carries `firingFence(...)`, which the host
 * checks under a share lock inside the mutation's own transaction.
 *
 * These cases pin the plugin's half of that contract: that the generation it
 * hands the host is the one it *currently* holds. They read the live fence row
 * at the moment of the call rather than comparing against a constant, because
 * `firing_token` is minted per claim and cleared by the `finally` — a test that
 * asserted a fixed value could pass while the plugin sent a stale token.
 *
 * The host half — that an obsolete generation is refused and that a racing
 * steal is serialized rather than interleaved — is proven against a real
 * PostgreSQL in `server/src/__tests__/issues-plugin-fencing-generation.test.ts`.
 */
describe("BLO-31049 — issue mutations carry the generation the host enforces", () => {
  /** The fence row as it stands *right now*, mid-delivery. */
  async function liveFencePrecondition() {
    const result = await db.query<{ firing_token: string | null; phase: string }>(
      `SELECT phase, firing_token FROM ${FENCES}
        WHERE company_id = $1 AND aggregate_key = $2`,
      [COMPANY_ID, AGGREGATE_KEY],
    );
    const row = result.rows[0];
    return {
      table: "alertmanager_aggregate_lifecycle_fences",
      match: {
        company_id: COMPANY_ID,
        aggregate_key: AGGREGATE_KEY,
        phase: row?.phase,
        firing_token: row?.firing_token,
      },
    };
  }

  it("sends the live generation with a re-fire description refresh", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.state.get.mockResolvedValue({
      paperclipIssueId: "issue-open",
      paperclipCompanyId: COMPANY_ID,
      aggregateKey: AGGREGATE_KEY,
      assigneeUserId: null,
      assigneeAgentId: "agent-fallback",
      alertname: ALERTNAME,
      severity: "critical",
      firstSeenAt: "2026-08-31T00:00:00Z",
      lastFiredAt: "2026-08-31T00:00:00Z",
      resolvedAt: null,
      operatorSuppressedAt: null,
      nextEscalationAt: null,
      escalationAttempt: 0,
      escalationComplete: true,
      escalationIntervalMs: null,
    } as never);
    // Not terminal => `decideRefire` returns `refresh`, the simplest path that
    // mutates the issue.
    mocks.issues.get.mockResolvedValue({ id: "issue-open", status: "todo" } as never);

    // Capture at call time: the fence is still held here, and released after.
    let sent: unknown;
    let live: unknown;
    mocks.issues.update.mockImplementation((async (...args: unknown[]) => {
      sent = (args[4] as { fencing?: unknown } | undefined)?.fencing;
      live = await liveFencePrecondition();
      return { id: "issue-open" };
    }) as never);

    await deliver(ctx);

    expect(mocks.issues.update).toHaveBeenCalled();
    // A held fence, and the exact generation holding it — not merely "some
    // fencing object was present".
    expect((live as { match: { firing_token: string | null } }).match.firing_token)
      .toEqual(expect.any(String));
    expect(sent).toEqual(live);
  });

  it("sends the live generation when it files the aggregate issue", async () => {
    const { ctx, mocks } = mkCtx();

    let sent: unknown;
    let live: unknown;
    mocks.issues.create.mockImplementation((async (input: { fencing?: unknown }) => {
      sent = input?.fencing;
      live = await liveFencePrecondition();
      return { id: "issue-created" };
    }) as never);

    await deliver(ctx);

    expect(mocks.issues.create).toHaveBeenCalled();
    expect((live as { match: { firing_token: string | null } }).match.firing_token)
      .toEqual(expect.any(String));
    expect(sent).toEqual(live);
  });
});

/**
 * BLO-31036 — the tail after the member write is fenced too.
 *
 * `upsertAggregateMember` proves ownership *at that statement* and nowhere
 * else. Ally's Critical was about what came next: `ctx.state.set` and
 * `ctx.events.emit` ran unguarded, so a steal committing in the gap let a
 * displaced predecessor overwrite the aggregate's alert state and announce a
 * firing for an aggregate it no longer owned. Winning the member write and
 * then losing the fence is a real interleaving, not a hypothetical — it is the
 * same rollout-mid-delivery sequence that wedged the 19 fences this ticket
 * exists to drain.
 *
 * Both call sites now carry `firingFence(...)`. As with the `issues.*` cases
 * above, these pin the *plugin's* half — that the generation it hands the host
 * is the one it currently holds, and that after a steal it is provably the
 * superseded one. The host's half (refusing an obsolete generation, and
 * serializing a racing steal rather than interleaving with it) is proven
 * against a real PostgreSQL in
 * `server/src/__tests__/issues-plugin-fencing-generation.test.ts`.
 */
describe("BLO-31036 — state and event publication carry the generation too", () => {
  const MEMBERS = `${NAMESPACE}.alertmanager_aggregate_members`;

  /** The fence row as it stands *right now*, mid-delivery. */
  async function liveFence() {
    const result = await db.query<{ firing_token: string | null; phase: string }>(
      `SELECT phase, firing_token FROM ${FENCES}
        WHERE company_id = $1 AND aggregate_key = $2`,
      [COMPANY_ID, AGGREGATE_KEY],
    );
    const row = result.rows[0];
    return {
      table: "alertmanager_aggregate_lifecycle_fences",
      match: {
        company_id: COMPANY_ID,
        aggregate_key: AGGREGATE_KEY,
        phase: row?.phase,
        firing_token: row?.firing_token,
      },
    };
  }

  /**
   * Steal the fence in the one window the member guard cannot cover: *after*
   * its INSERT has already committed. The predecessor is admitted as a member
   * and only then displaced, so it reaches the state/event tail believing it
   * still owns the aggregate. This is deliberately a different instant from
   * `stealFenceOnClaim` above, which lands early enough for the barrier to
   * reject the whole delivery.
   */
  function stealFenceAfterMemberWrite(mocks: ReturnType<typeof mkCtx>["mocks"]) {
    const passthrough = mocks.db.execute.getMockImplementation()!;
    let stolen = false;
    mocks.db.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const result = await passthrough(sql, params);
      if (!stolen && sql.includes(MEMBERS) && sql.includes("INSERT INTO")) {
        stolen = true;
        await db.query(
          `UPDATE ${FENCES}
              SET firing_token = $1, owner_instance_id = $2, owner_slot = $3
            WHERE company_id = $4 AND aggregate_key = $5`,
          ["token-replacement", "instance-replacement", SELF.slot, COMPANY_ID, AGGREGATE_KEY],
        );
      }
      return result;
    });
  }

  /** The `fencing` option passed to `ctx.state.set(ref, value, options)`. */
  const stateSetFencing = (mocks: ReturnType<typeof mkCtx>["mocks"]) =>
    (mocks.state.set.mock.calls[0]?.[2] as { fencing?: unknown } | undefined)?.fencing;

  /** The `fencing` option passed to `ctx.events.emit(name, company, payload, options)`. */
  const emitFencing = (mocks: ReturnType<typeof mkCtx>["mocks"]) =>
    (mocks.events.emit.mock.calls[0]?.[3] as { fencing?: unknown } | undefined)?.fencing;

  it("sends the live generation with the creation path's state write and firing event", async () => {
    const { ctx, mocks } = mkCtx();

    await deliver(ctx);

    expect(mocks.state.set).toHaveBeenCalled();
    expect(mocks.events.emit).toHaveBeenCalled();
    // The member write proves the delivery held the fence; both tail calls must
    // carry that same generation, not merely "some fencing object".
    const token = (stateSetFencing(mocks) as { match: { firing_token: string | null } })
      ?.match?.firing_token;
    expect(token).toEqual(expect.any(String));
    expect(emitFencing(mocks)).toEqual(stateSetFencing(mocks));
  });

  it("sends the live generation with the re-fire path's state write and firing event", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.state.get.mockResolvedValue({
      paperclipIssueId: "issue-open",
      paperclipCompanyId: COMPANY_ID,
      aggregateKey: AGGREGATE_KEY,
      assigneeUserId: null,
      assigneeAgentId: "agent-fallback",
      alertname: ALERTNAME,
      severity: "critical",
      firstSeenAt: "2026-08-31T00:00:00Z",
      lastFiredAt: "2026-08-31T00:00:00Z",
      resolvedAt: null,
      operatorSuppressedAt: null,
      nextEscalationAt: null,
      escalationAttempt: 0,
      escalationComplete: true,
      escalationIntervalMs: null,
    } as never);
    mocks.issues.get.mockResolvedValue({ id: "issue-open", status: "todo" } as never);

    // Captured at call time: the fence is still held here and cleared by the
    // `finally`, so reading it after `deliver` would compare against nothing.
    let live: unknown;
    mocks.state.set.mockImplementation((async () => {
      live = await liveFence();
    }) as never);

    await deliver(ctx);

    expect(mocks.state.set).toHaveBeenCalled();
    expect((live as { match: { firing_token: string | null } }).match.firing_token)
      .toEqual(expect.any(String));
    expect(stateSetFencing(mocks)).toEqual(live);
    expect(emitFencing(mocks)).toEqual(live);
  });

  it("hands the host a superseded generation when displaced after the member write", async () => {
    const { ctx, mocks } = mkCtx();
    stealFenceAfterMemberWrite(mocks);

    // The delivery is *not* rejected locally, and that is the point: the member
    // write already succeeded, and the barrier ahead of it ran while the fence
    // was still held. Nothing inside the plugin can see the steal. The only
    // thing standing between this predecessor and a stale publish is that the
    // generation it sends no longer matches the row.
    await deliver(ctx).catch(() => {
      /* the `finally` also fails once the token is gone; irrelevant here */
    });

    const sent = stateSetFencing(mocks) as
      | { match: { firing_token: string | null } }
      | undefined;
    expect(sent).toBeDefined();
    expect(emitFencing(mocks)).toEqual(sent);

    // The fence now belongs to the replacement, and what the predecessor sent
    // does not match it — so `assertPluginFencingGeneration` rejects both the
    // state write and the emit. Asserting the mismatch rather than the refusal
    // is deliberate: the refusal happens in the host, which this suite mocks.
    const fence = await readFence();
    expect(fence?.firing_token).toBe("token-replacement");
    expect(sent!.match.firing_token).not.toBe("token-replacement");
    expect(sent!.match.firing_token).toEqual(expect.any(String));
  });
});
