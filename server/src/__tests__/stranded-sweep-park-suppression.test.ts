import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { isDeliberateParkActive } from "../services/issue-park-expiry.js";
import { recoveryService } from "../services/recovery/service.js";

/**
 * PEN-4871: a live deliberate park must suppress RE-DISPATCH, not only escalation.
 *
 * The park was honoured by the liveness classifier and by the GitHub webhook, so a parked
 * row stopped being FLAGGED as stranded — and went on being WOKEN by
 * `runStrandedAssignedIssueSweep`, roughly nine minutes after every park, at the cost of a
 * full agent session each time.
 *
 * Structure mirrors `issue-park-expiry-sweep.test.ts`, deliberately: a cheap pure block for
 * the predicate, then the sweep itself against embedded Postgres. PEN-4419's finding is the
 * reason the second block is not mocked — *a pure TS test of a sweep passes identically
 * when the query matches nothing*. That cuts slightly differently here, because this fix
 * lives in TypeScript rather than in the candidate SQL, but the risk it names is the same
 * one and is if anything sharper: a filter that is correct and simply never reached would
 * satisfy any test written against the filter alone.
 *
 * Every assertion below is TWO-SIDED, in the same `it` wherever the rows can share a sweep.
 * A single-sided test — "a parked row is not dispatched" — scores an unconditional
 * never-dispatch and a correct fix identically, and never-dispatch is the strictly worse
 * bug: it converts a deliberate, expiring pause into a permanent silent strand.
 */

const NOW_MS = new Date("2026-10-20T10:00:00.000Z").getTime();
const LIVE_PARK = new Date("2026-10-20T11:00:00.000Z");
const LAPSED_PARK = new Date("2026-10-20T09:00:00.000Z");

describe("isDeliberateParkActive (PEN-4871)", () => {
  it("is true for a live park and false for a lapsed one", () => {
    expect(isDeliberateParkActive(LIVE_PARK, NOW_MS)).toBe(true);
    // The arm that keeps this fix from becoming a second, silent strand.
    expect(isDeliberateParkActive(LAPSED_PARK, NOW_MS)).toBe(false);
  });

  it("treats the deadline as exclusive, so a park expiring exactly now is lapsed", () => {
    // Matches the release edge, which claims a park at `<= now` and must not contend with
    // a suppression that still considers the same instant live.
    expect(isDeliberateParkActive(new Date(NOW_MS), NOW_MS)).toBe(false);
    expect(isDeliberateParkActive(new Date(NOW_MS + 1), NOW_MS)).toBe(true);
  });

  it("reads an absent or unparseable deadline as NOT parked", () => {
    // Suppression must be earned, never fallen into: an unreadable column silencing a row
    // is the failure this whole issue is about, pointed the other way.
    expect(isDeliberateParkActive(null, NOW_MS)).toBe(false);
    expect(isDeliberateParkActive(undefined, NOW_MS)).toBe(false);
    expect(isDeliberateParkActive("not a date", NOW_MS)).toBe(false);
    expect(isDeliberateParkActive("", NOW_MS)).toBe(false);
  });

  it("accepts the ISO string form the column round-trips as", () => {
    expect(isDeliberateParkActive(LIVE_PARK.toISOString(), NOW_MS)).toBe(true);
    expect(isDeliberateParkActive(LAPSED_PARK.toISOString(), NOW_MS)).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stranded-sweep park tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("stranded assigned issue sweep — live park suppression", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stranded-park-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    // A no-op drain is correct here, not a shortcut: `enqueueWakeup` is mocked, so this
    // suite never starts a real run and has nothing in flight to wait for. The helper is
    // still the right cleanup — the `companies` TRUNCATE cascade is what keeps one test's
    // parked rows out of the next test's `parkSuppressed` count.
    await cleanupHeartbeatTestState(db, { drainInFlightExecutions: async () => {} });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * One company, one agent, N issues — so a single sweep sees every arm and the comparison
   * cannot be confounded by per-company ordering or capacity.
   */
  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
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
    return { companyId, agentId, issuePrefix };
  }

  /**
   * A `todo` row, assigned, with no run and no monitor: the shape the sweep's
   * `assignmentDispatched` lane picks up unconditionally. That lane is chosen because it is
   * the shortest path from candidate to `deps.enqueueWakeup`, so a row reaching it is
   * unambiguous evidence the park filter did not hold it back.
   */
  async function seedIssue(
    ctx: { companyId: string; agentId: string; issuePrefix: string },
    n: number,
    parkedUntil: Date | null,
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: ctx.companyId,
      title: parkedUntil ? `Parked until ${parkedUntil.toISOString()}` : "Never parked",
      status: "todo",
      priority: "medium",
      assigneeAgentId: ctx.agentId,
      assigneeUserId: null,
      issueNumber: n,
      identifier: `${ctx.issuePrefix}-${n}`,
      ...(parkedUntil
        ? {
            parkedUntil,
            parkedReason: "Waiting on a human merge click; polling cannot move this.",
            parkedByAgentId: ctx.agentId,
            parkedAt: new Date(parkedUntil.getTime() - 24 * 60 * 60 * 1000),
          }
        : {}),
    });
    return issueId;
  }

  const sweep = async () => {
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }) as never);
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();
    return { result, enqueueWakeup };
  };

  it("does not dispatch a live-parked row, and still dispatches a lapsed-parked and an unparked one (two-sided)", async () => {
    const ctx = await seedCompany();
    // Parks are anchored off the wall clock the sweep will actually read. A fixed date
    // would make this test start passing for the wrong reason once that date is in the
    // past for both rows.
    const live = await seedIssue(ctx, 1, new Date(Date.now() + 36 * 60 * 60 * 1000));
    const lapsed = await seedIssue(ctx, 2, new Date(Date.now() - 60 * 60 * 1000));
    const unparked = await seedIssue(ctx, 3, null);

    const { result } = await sweep();

    // The fix.
    expect(result.issueIds).not.toContain(live);
    expect(result.parkSuppressed).toBe(1);
    // Both other arms. Without these the suite scores "never dispatch anything" as a pass.
    expect(result.issueIds).toEqual(expect.arrayContaining([lapsed, unparked]));
    expect(result.assignmentDispatched).toBe(2);
  });

  it("counts live-parked rows OUT of the scanned population rather than into `skipped`", async () => {
    // `candidatesScanned` drives the truncation signal `candidatesScanned -
    // candidatesReached`; a suppressed row left in that figure would read as a candidate
    // the budgeted loop never got to, which is a different and much more alarming fault.
    const ctx = await seedCompany();
    await seedIssue(ctx, 1, new Date(Date.now() + 36 * 60 * 60 * 1000));
    await seedIssue(ctx, 2, null);

    const { result } = await sweep();

    expect(result.parkSuppressed).toBe(1);
    expect(result.candidatesScanned).toBe(1);
    expect(result.candidatesReached).toBe(1);
    expect(result.budgetExhausted).toBe(false);
  });

  it("suppresses on every status the sweep selects, not just todo", async () => {
    // `STRANDED_ASSIGNED_ISSUE_STATUSES` is todo/in_progress/in_review. The original defect
    // was reported on an `in_progress` row, so a fix that only covered `todo` would leave
    // the reported case live.
    const ctx = await seedCompany();
    const parkedUntil = new Date(Date.now() + 36 * 60 * 60 * 1000);
    let n = 0;
    for (const status of ["todo", "in_progress", "in_review"] as const) {
      n += 1;
      const issueId = await seedIssue(ctx, n, parkedUntil);
      await db.update(issues).set({ status }).where(eq(issues.id, issueId));
    }

    const { result } = await sweep();

    expect(result.parkSuppressed).toBe(3);
    expect(result.candidatesScanned).toBe(0);
    expect(result.issueIds).toEqual([]);
  });
});
