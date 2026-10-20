import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import {
  ISSUE_PARK_EXPIRED_WAKE_REASON,
  buildIssueParkExpiredWakeIdempotencyKey,
  issueParkOwesReleaseWake,
} from "../services/issue-park-expiry.js";

/**
 * PEN-4420: the park's release edge.
 *
 * The predicate block below is pure and cheap. The sweep block is deliberately run
 * against embedded Postgres rather than a mocked `db`, because this change is a sweep and
 * PEN-4419 recorded the failure mode precisely: *a pure TS test of a sweep passes
 * identically when the query matches nothing*. The claim is a conditional UPDATE and the
 * candidate selection leans on a partial index, so the SQL is the part most able to be
 * wrong.
 *
 * Both halves of the two-sided requirement are asserted in the same `it` wherever
 * possible, on purpose. A single-sided test — "a parked row wakes" — scores an
 * unconditional always-wake and a correct fix identically, which is the specific wrong
 * fix PEN-4419 asked to be guarded against.
 */

const BASE_PARK = {
  status: "todo",
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  parkedUntil: new Date("2026-10-20T09:00:00.000Z"),
  parkedAt: new Date("2026-10-19T09:00:00.000Z"),
  parkedWakeFiredAt: null,
};
const NOW_MS = new Date("2026-10-20T10:00:00.000Z").getTime();

describe("issueParkOwesReleaseWake", () => {
  it("owes a wake for a lapsed park, and does not for a live one", () => {
    expect(issueParkOwesReleaseWake(BASE_PARK, NOW_MS)).toBe(true);
    // The other side. A live park is PEN-4114's suppression window and must stay inert.
    expect(
      issueParkOwesReleaseWake(
        { ...BASE_PARK, parkedUntil: new Date("2026-10-20T11:00:00.000Z") },
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("does not owe a wake for an unparked row", () => {
    expect(issueParkOwesReleaseWake({ ...BASE_PARK, parkedUntil: null, parkedAt: null }, NOW_MS))
      .toBe(false);
  });

  it("owes exactly one wake per park: fired once, then not again", () => {
    const fired = { ...BASE_PARK, parkedWakeFiredAt: new Date("2026-10-20T09:30:00.000Z") };
    expect(issueParkOwesReleaseWake(fired, NOW_MS)).toBe(false);
  });

  it("re-arms when the row is re-parked after a wake already fired", () => {
    // `parkedAt` is restamped by the writer on every disposition write, so a marker that
    // predates the current park has not fired for THIS park. This is the backstop that
    // keeps a writer which forgets to reset the marker from silencing the row forever.
    expect(
      issueParkOwesReleaseWake(
        {
          ...BASE_PARK,
          parkedWakeFiredAt: new Date("2026-10-18T09:00:00.000Z"),
          parkedAt: new Date("2026-10-19T09:00:00.000Z"),
        },
        NOW_MS,
      ),
    ).toBe(true);
  });

  it("fires on every status a park can be set on", () => {
    for (const status of ["backlog", "todo", "in_progress", "in_review"]) {
      expect(issueParkOwesReleaseWake({ ...BASE_PARK, status }, NOW_MS), status).toBe(true);
    }
  });

  it("does not fire on closed rows or on blocked", () => {
    // `done`/`cancelled` would be a wake that revives finished work (BLO-23206). `blocked`
    // has its own wake path and a deadline does not resolve a blocker.
    for (const status of ["done", "cancelled", "blocked"]) {
      expect(issueParkOwesReleaseWake({ ...BASE_PARK, status }, NOW_MS), status).toBe(false);
    }
  });

  it("does not fire without an agent to wake", () => {
    expect(issueParkOwesReleaseWake({ ...BASE_PARK, assigneeAgentId: null }, NOW_MS)).toBe(false);
    expect(issueParkOwesReleaseWake({ ...BASE_PARK, assigneeUserId: "user-1" }, NOW_MS)).toBe(false);
  });

  it("keys the idempotency key on the park, not the issue", () => {
    const first = buildIssueParkExpiredWakeIdempotencyKey({
      issueId: "issue-1",
      parkedAt: new Date("2026-10-19T09:00:00.000Z"),
    });
    const afterRepark = buildIssueParkExpiredWakeIdempotencyKey({
      issueId: "issue-1",
      parkedAt: new Date("2026-10-21T09:00:00.000Z"),
    });
    expect(first).not.toBe(afterRepark);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue park expiry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue park expiry sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const heartbeatServices = new Set<ReturnType<typeof heartbeatService>>();

  const createHeartbeat = () => {
    const service = heartbeatService(db);
    heartbeatServices.add(service);
    return service;
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-park-");
    db = createDb(tempDb.connectionString);
  });

  // Matches the margin issue-monitor-scheduler.test.ts documents under PEN-3508: these
  // tests spawn real (no-op) agent runs against embedded Postgres, and a tight budget
  // produces false reds on a loaded host rather than catching any defect.
  async function waitForHeartbeatIdle(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue park expiry heartbeat runs to settle");
  }

  afterEach(async () => {
    const servicesToDrain = [...heartbeatServices];
    heartbeatServices.clear();
    // These tests start REAL agent runs, and a started run's lifecycle hooks write tables
    // this suite never names — `workspace_operations` is the one that surfaced, but the
    // set is open-ended and grows with the platform. A hand-ordered delete list is only
    // correct while nothing else is writing, which is precisely what a spawned run breaks,
    // so naming one more table would leave the next one as a latent red. Delegate to the
    // canonical heartbeat cleanup instead: it cancels active runs, drains the
    // fire-and-forget execution chains, then wipes the `companies` cascade in a single
    // lock-serialized TRUNCATE. See helpers/truncate-company-scoped-test-state.ts —
    // "Ordering was never the bug, so re-ordering was never the fix."
    await cleanupHeartbeatTestState(
      db,
      {
        // The suite builds a heartbeat service per test, so drain every one of them
        // behind the single handle the helper expects.
        drainInFlightExecutions: async (timeoutMs?: number) => {
          await Promise.all(
            servicesToDrain.map((service) => service.drainInFlightExecutions(timeoutMs)),
          );
        },
      },
      // `instance_settings` is a singleton, not company-scoped, so the cascade cannot
      // reach it and a leaked row would configure the next test.
      { extraTruncateTables: ["instance_settings"], drainTimeoutMs: 60_000 },
    );
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Seeds a row with a REAL park — the four `parked_*` columns as the writer sets them —
   * and NO monitor, which is exactly the shape measured as stranded on 2026-10-20.
   */
  async function seedParkedIssue(input: {
    status?: string;
    /** `null` seeds an UNPARKED row: the negative arm of the two-sided test. */
    parkedUntil?: Date | null;
    parkedWakeFiredAt?: Date | null;
    assignToAgent?: boolean;
    assigneeUserId?: string | null;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const parkedUntil = input.parkedUntil === undefined
      ? new Date(Date.now() - 60 * 60 * 1000)
      : input.parkedUntil;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Park Bot",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Parked on a human gate",
      status: input.status ?? "todo",
      priority: "medium",
      assigneeAgentId: input.assignToAgent === false ? null : agentId,
      assigneeUserId: input.assigneeUserId ?? null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      // No monitor, deliberately: this is the population with no other wake path.
      ...(parkedUntil
        ? {
            parkedUntil,
            parkedReason: "Waiting on a human merge click; polling cannot move this.",
            parkedByAgentId: agentId,
            parkedAt: new Date(parkedUntil.getTime() - 24 * 60 * 60 * 1000),
          }
        : {}),
      ...(input.parkedWakeFiredAt !== undefined
        ? { parkedWakeFiredAt: input.parkedWakeFiredAt }
        : {}),
    });

    return { companyId, agentId, issueId };
  }

  async function parkWakesFor(issueId: string) {
    return db
      .select({ id: agentWakeupRequests.id, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(
        sql`${agentWakeupRequests.reason} = ${ISSUE_PARK_EXPIRED_WAKE_REASON}
            and ${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      );
  }

  async function readParkState(issueId: string) {
    return db
      .select({
        parkedUntil: issues.parkedUntil,
        parkedAt: issues.parkedAt,
        parkedWakeFiredAt: issues.parkedWakeFiredAt,
        status: issues.status,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  it("wakes a parked row at expiry and leaves an unparked row alone (two-sided)", async () => {
    const parked = await seedParkedIssue();
    const unparked = await seedParkedIssue({ parkedUntil: null });
    const heartbeat = createHeartbeat();

    const result = await heartbeat.__test_tickExpiredIssueParks();
    await waitForHeartbeatIdle();

    expect(result.woken).toBe(1);
    expect(await parkWakesFor(parked.issueId)).toHaveLength(1);
    // The arm that makes this test able to fail against an unconditional always-wake.
    expect(await parkWakesFor(unparked.issueId)).toHaveLength(0);
    expect((await readParkState(parked.issueId))?.parkedWakeFiredAt).not.toBeNull();
    expect((await readParkState(unparked.issueId))?.parkedWakeFiredAt).toBeNull();
  }, 120_000);

  it("does not wake a row whose park is still live (PEN-4114 window unchanged)", async () => {
    const live = await seedParkedIssue({ parkedUntil: new Date(Date.now() + 60 * 60 * 1000) });
    const heartbeat = createHeartbeat();

    const result = await heartbeat.__test_tickExpiredIssueParks();
    await waitForHeartbeatIdle();

    expect(result.woken).toBe(0);
    expect(await parkWakesFor(live.issueId)).toHaveLength(0);
    // The park is untouched, so PEN-4114's suppression predicate still reads it as live.
    expect((await readParkState(live.issueId))?.parkedWakeFiredAt).toBeNull();
  }, 120_000);

  it("fires one wake across N sweeps of one expired park (idempotence)", async () => {
    const parked = await seedParkedIssue();
    const heartbeat = createHeartbeat();

    const results = [];
    for (let pass = 0; pass < 4; pass += 1) {
      results.push(await heartbeat.__test_tickExpiredIssueParks());
      await waitForHeartbeatIdle();
    }

    expect(results.map((r) => r.woken)).toEqual([1, 0, 0, 0]);
    expect(await parkWakesFor(parked.issueId)).toHaveLength(1);
  }, 180_000);

  it("fires one wake when two sweeps race the same expired park", async () => {
    // The single-process idempotence test above is satisfied by the TS predicate alone,
    // because the second pass re-reads the marker the first pass wrote. This one summons
    // the condition that predicate cannot see: two loops that both read `parkedWakeFiredAt`
    // as null before either writes it. Only the conditional UPDATE claim settles that, so
    // this is the assertion that holds the claim in place rather than trusting it.
    const parked = await seedParkedIssue();
    const first = createHeartbeat();
    const second = createHeartbeat();

    const results = await Promise.all([
      first.__test_tickExpiredIssueParks(),
      second.__test_tickExpiredIssueParks(),
    ]);
    await waitForHeartbeatIdle();

    expect(results.reduce((total, r) => total + r.woken, 0)).toBe(1);
    expect(await parkWakesFor(parked.issueId)).toHaveLength(1);
  }, 180_000);

  it("fires on every status a park can be set on", async () => {
    const seeded = await Promise.all(
      ["backlog", "todo", "in_progress", "in_review"].map((status) => seedParkedIssue({ status })),
    );
    const heartbeat = createHeartbeat();

    const result = await heartbeat.__test_tickExpiredIssueParks();
    await waitForHeartbeatIdle();

    expect(result.woken).toBe(4);
    for (const row of seeded) {
      expect(await parkWakesFor(row.issueId), row.issueId).toHaveLength(1);
    }
  }, 180_000);

  it("does not fire on closed rows, blocked rows, or rows with no agent target", async () => {
    const ineligible = await Promise.all([
      seedParkedIssue({ status: "done" }),
      seedParkedIssue({ status: "cancelled" }),
      seedParkedIssue({ status: "blocked" }),
      seedParkedIssue({ assignToAgent: false }),
      seedParkedIssue({ assigneeUserId: "human-reviewer" }),
    ]);
    const heartbeat = createHeartbeat();

    const result = await heartbeat.__test_tickExpiredIssueParks();
    await waitForHeartbeatIdle();

    expect(result.woken).toBe(0);
    for (const row of ineligible) {
      expect(await parkWakesFor(row.issueId), row.issueId).toHaveLength(0);
    }
  }, 180_000);

  it("re-arms the release edge through the real park writer, and clears it on un-park", async () => {
    // Drives `issueService.update`'s own `parkedDisposition` derivation rather than
    // seeding the columns, because the writer's reset is the mechanism that keeps the
    // release edge per-PARK instead of per-row. Without it a row woken once would need
    // the `parkedWakeFiredAt < parkedAt` backstop to re-arm, and a backstop nothing
    // exercises is a backstop nobody knows is broken.
    const parked = await seedParkedIssue();
    const heartbeat = createHeartbeat();
    const svc = issueService(db);

    await heartbeat.__test_tickExpiredIssueParks();
    await waitForHeartbeatIdle();
    expect((await readParkState(parked.issueId))?.parkedWakeFiredAt).not.toBeNull();

    // Re-park: the marker must be cleared, so this park gets its own wake.
    await svc.update(parked.issueId, {
      parkedDisposition: {
        reason: "Still waiting on the same human merge click.",
        until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      actorAgentId: parked.agentId,
    });
    expect((await readParkState(parked.issueId))?.parkedWakeFiredAt).toBeNull();

    // Un-park: nothing describes a park any more, so the marker goes with it.
    await svc.update(parked.issueId, {
      parkedDisposition: null,
      actorAgentId: parked.agentId,
    });
    const unparked = await readParkState(parked.issueId);
    expect(unparked?.parkedUntil).toBeNull();
    expect(unparked?.parkedWakeFiredAt).toBeNull();
  }, 180_000);

  it("re-arms the release edge when a row is re-parked after its wake fired", async () => {
    // Seeded as already-fired for a PREVIOUS park: the marker predates `parkedAt`, which
    // is the state the writer produces when it restamps `parkedAt` on a re-park.
    const reparked = await seedParkedIssue({
      parkedWakeFiredAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
    });
    const heartbeat = createHeartbeat();

    const result = await heartbeat.__test_tickExpiredIssueParks();
    await waitForHeartbeatIdle();

    expect(result.woken).toBe(1);
    expect(await parkWakesFor(reparked.issueId)).toHaveLength(1);
  }, 120_000);
});
