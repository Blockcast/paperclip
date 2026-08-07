import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale-lock sweeper tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery sweepStaleIssueLocks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-lock-sweep-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    // Must precede heartbeatRuns: the promotion tests drive
    // promoteDueScheduledRetries, which writes heartbeat_run_events, and the FK
    // heartbeat_run_events_run_id_heartbeat_runs_id_fk otherwise blocks the
    // delete and fails whichever test happens to run next.
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const failedRunId = randomUUID();
    const runningRunId = randomUUID();
    const queuedRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date(),
      },
      {
        id: runningRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
      {
        // BLO-18995: never-started run — queued, startedAt null.
        id: queuedRunId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "automation",
        startedAt: null,
      },
    ]);

    return { companyId, agentId, failedRunId, runningRunId, queuedRunId };
  }

  it("clears lock columns when checkoutRunId points at a terminal heartbeat run", async () => {
    const { companyId, agentId, failedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale lock — terminal checkoutRunId",
      // Status off in_progress + checkoutRunId still set → exactly the recurrence shape.
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: null,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: null, executionRunId: null, executionLockedAt: null });

    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stale_lock_cleared"))
      .then((rows) => rows[0]);
    expect(audit?.action).toBe("issue.stale_lock_cleared");
    expect((audit?.details as { clearedCheckoutRunId?: string } | null)?.clearedCheckoutRunId).toBe(
      failedRunId,
    );
  });

  it("does not clear locks while the referenced run is still running", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live lock — must be preserved",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: runningRunId, executionRunId: runningRunId });
  });

  it("does not clear when checkoutRunId is terminal but executionRunId is still running", async () => {
    const { companyId, agentId, failedRunId, runningRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mixed lock — preserve",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: failedRunId, executionRunId: runningRunId });
  });

  it("is idempotent — second pass finds nothing to clear", async () => {
    const { companyId, agentId, failedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Idempotency",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: null,
    });

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.sweepStaleIssueLocks();
    const second = await heartbeat.sweepStaleIssueLocks();
    expect(first.cleared).toBe(1);
    expect(second.cleared).toBe(0);
  });

  // BLO-18995: four enqueue paths stamp executionRunId/executionLockedAt at
  // *enqueue* time next to a freshly-inserted `queued` run instead of lazily at
  // claim time. `queued` is neither missing nor terminal, so isCleanable()
  // returned false forever and this sweeper — the designated backstop — never
  // cleared the lock, while enqueueWakeup parked every later wake for the issue
  // as `deferred_issue_execution` behind a holder that may never start. There
  // was no timeout anywhere in the path. Observed live on BLO-18939.
  it("clears an execution lock held past the timeout by a run that never started (BLO-18995)", async () => {
    const { companyId, agentId, queuedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pre-claim lock held by a never-started run",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: queuedRunId,
      // Past STALE_PRE_CLAIM_ISSUE_LOCK_MS (6h).
      executionLockedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ executionRunId: null, executionLockedAt: null });

    // The run itself is untouched — clearing the lock must not cancel queued
    // work; claimQueuedRun re-acquires the lock if the run is later claimed.
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId))
      .then((rows) => rows[0]);
    expect(run?.status).toBe("queued");

    const audit = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stale_lock_cleared"))
      .then((rows) => rows[0]);
    expect((audit?.details as { reason?: string } | null)?.reason).toBe("pre_claim_lock_expired");
  });

  it("preserves a pre-claim execution lock that is still within the timeout (BLO-18995)", async () => {
    // The timeout must be a real bound, not an immediate release: a queued run
    // legitimately waits behind a backlog, and clearing its lock early would
    // let duplicate wakes queue for the same issue.
    const { companyId, agentId, queuedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pre-claim lock still fresh",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: queuedRunId,
      executionLockedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.executionRunId).toBe(queuedRunId);
  });

  it("clears a parked scheduled retry whose lock is older than the timeout (BLO-21309)", async () => {
    // Replaces "preserves a future scheduled retry even when its lock is older
    // than the timeout", which asserted the BLO-21309 bug: the staleness basis
    // was the FUTURE scheduledRetryAt, so `now - basis` was negative and the
    // lock survived the entire park. A ccrotate_capacity park is set from the
    // provider's capacity-reset horizon (~4 days here), and for that whole
    // window the issue's own assignee could not set status or re-arm its
    // monitor. The lock bound must be independent of the retry horizon.
    const { companyId, agentId } = await seed();
    const retryRunId = randomUUID();
    const issueId = randomUUID();
    const scheduledRetryAt = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      companyId,
      agentId,
      status: "scheduled_retry",
      invocationSource: "automation",
      startedAt: null,
      scheduledRetryAt,
      scheduledRetryAttempt: 0,
      scheduledRetryReason: "ccrotate_capacity",
      errorCode: "rate_limit_exhausted",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Parked ccrotate_capacity retry holding the lock",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: retryRunId,
      executionLockedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    expect(result.issueIds).toContain(issueId);
    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.executionRunId).toBeNull();
    expect(row?.executionLockedAt).toBeNull();

    // The park itself must survive: releasing the lock is not a cancellation,
    // and the retry re-acquires via claimQueuedRun when it is finally claimed.
    const retryRun = await db
      .select({ status: heartbeatRuns.status, scheduledRetryAt: heartbeatRuns.scheduledRetryAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId))
      .then((rows) => rows[0]);
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe(scheduledRetryAt.toISOString());
  });

  it("preserves a parked scheduled retry whose lock is still within the timeout (BLO-21309)", async () => {
    // Keeps the bound a real bound rather than an immediate release, mirroring
    // the BLO-18995 pairing for `queued`: a short rate-limit retry (flat ~90s
    // curve) must never have its lock stripped out from under it.
    const { companyId, agentId } = await seed();
    const retryRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      companyId,
      agentId,
      status: "scheduled_retry",
      invocationSource: "automation",
      startedAt: null,
      scheduledRetryAt: new Date(Date.now() + 90 * 1000),
      scheduledRetryAttempt: 0,
      scheduledRetryReason: "ccrotate_capacity",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Freshly parked retry",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: retryRunId,
      executionLockedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.executionRunId).toBe(retryRunId);
    expect(row?.executionLockedAt).not.toBeNull();
  });

  it("does not clear a live checkout lock just because the execution lock expired (BLO-18995)", async () => {
    // The sweeper nulls checkoutRunId and executionRunId in one UPDATE, so the
    // new pre-claim-expiry allowance must not become a blanket bypass of the
    // checkout check. An issue whose checkoutRunId points at a live run keeps
    // its checkout lock no matter how stale the execution lock is.
    const { companyId, agentId, runningRunId, queuedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Expired execution lock, live checkout lock",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: queuedRunId,
      executionLockedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: runningRunId, executionRunId: queuedRunId });
  });

  it("clears an expired pre-claim lock when the same queued run also holds checkout (BLO-19566)", async () => {
    // Contrast with the test directly above: there, checkoutRunId points at a
    // *different* live run and the checkout guard rightly wins. Here both
    // columns point at the SAME never-started run, which is what a normal
    // checkout produces — it stamps checkout and execution together. BLO-19941
    // opened the checkout guard for that shape but only for a `running` holder,
    // leaving the BLO-18995 pre-claim path unreachable for every
    // checkout-stamped issue. Measured on the live fleet 2026-08-01T05:32Z, the
    // only two pins in the whole fleet past the 6h bound were both in this
    // population (BLO-19999 8.6h, BLO-20042 6.8h).
    const { companyId, agentId, queuedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pre-claim lock where one queued run holds checkout and execution",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      checkoutRunId: queuedRunId,
      executionRunId: queuedRunId,
      // Past STALE_PRE_CLAIM_ISSUE_LOCK_MS (6h).
      executionLockedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: null, executionRunId: null, executionLockedAt: null });

    // Non-destructive in the same way as every other branch: the queued run is
    // left alone and re-acquires the lock if it is ever claimed.
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId))
      .then((rows) => rows[0]);
    expect(run?.status).toBe("queued");

    // Attributed to the pre-claim bound, not the BLO-19941 running-silent one.
    const audit = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stale_lock_cleared"))
      .then((rows) => rows[0]);
    const details = audit?.details as
      | { reason?: string; preClaimLockTimeoutMs?: number }
      | null;
    expect(details?.reason).toBe("pre_claim_lock_expired");
    expect(details?.preClaimLockTimeoutMs).toBe(6 * 60 * 60 * 1000);
  });

  it("preserves a fresh pre-claim lock even when the same queued run holds checkout (BLO-19566)", async () => {
    // The widened checkout allowance must stay bounded by the same 6h timeout —
    // it opens the guard for the same-run shape, it does not make that shape
    // sweepable on sight.
    const { companyId, agentId, queuedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fresh pre-claim lock, same run holds checkout",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      checkoutRunId: queuedRunId,
      executionRunId: queuedRunId,
      // Well inside STALE_PRE_CLAIM_ISSUE_LOCK_MS (6h).
      executionLockedAt: new Date(Date.now() - 30 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: queuedRunId, executionRunId: queuedRunId });
  });

  it("does not clear a stale pre-claim lock if a claim refreshes executionLockedAt after scan", async () => {
    const { companyId, agentId, queuedRunId } = await seed();
    const issueId = randomUUID();
    const staleLockedAt = new Date(Date.now() - 7 * 60 * 60 * 1000);
    const refreshedLockedAt = new Date();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pre-claim lock claimed during sweep",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: queuedRunId,
      executionLockedAt: staleLockedAt,
    });

    const heartbeat = heartbeatService(db);
    let sweepPromise: ReturnType<typeof heartbeat.sweepStaleIssueLocks> | null = null;

    await db.transaction(async (tx) => {
      await tx.execute(sql`select id from issues where id = ${issueId} for update`);
      sweepPromise = heartbeat.sweepStaleIssueLocks();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await tx
        .update(issues)
        .set({ executionLockedAt: refreshedLockedAt, updatedAt: refreshedLockedAt })
        .where(eq(issues.id, issueId));
    });

    expect(sweepPromise).not.toBeNull();
    const result = await sweepPromise!;

    expect(result.cleared).toBe(0);
    // BLO-22060: a bump landing on the sweep's own 30s cadence can starve the
    // clear indefinitely, and `cleared: 0` alone reads identically to a quiet
    // pass. Count the bailout so the starvation is observable.
    expect(result.skippedByConcurrentLockChange).toBe(1);
    expect(result.skippedByConcurrentLockChangeIssueIds).toEqual([issueId]);
    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.executionRunId).toBe(queuedRunId);
    expect(row?.executionLockedAt?.getTime()).toBe(refreshedLockedAt.getTime());
  });

  it("promotes the oldest eligible deferred issue wake after clearing an expired pre-claim lock", async () => {
    const { companyId, agentId, queuedRunId } = await seed();
    const issueId = randomUUID();
    const deferredWakeId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Expired holder with deferred follow-up",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      checkoutRunId: null,
      executionRunId: queuedRunId,
      executionLockedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        commentId: "comment-1",
        _paperclipWakeContext: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_comment_followup",
        },
      },
      status: "deferred_issue_execution",
      requestedByActorType: "system",
      requestedByActorId: null,
      requestedAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        runId: agentWakeupRequests.runId,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId))
      .then((rows) => rows[0]);
    expect(wake).toMatchObject({
      status: "queued",
      reason: "issue_execution_promoted",
      error: null,
    });
    expect(wake?.runId).toBeTruthy();
    expect(wake?.runId).not.toBe(queuedRunId);

    const promotedRun = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        responsibleUserId: heartbeatRuns.responsibleUserId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wake!.runId!))
      .then((rows) => rows[0]);
    expect(promotedRun).toMatchObject({
      id: wake?.runId,
      status: "queued",
      wakeupRequestId: deferredWakeId,
      responsibleUserId: "responsible-user",
    });
    expect(promotedRun?.contextSnapshot).toMatchObject({
      issueId,
      taskId: issueId,
      wakeReason: "issue_comment_followup",
      wakeSource: "automation",
      wakeTriggerDetail: "system",
      commentId: "comment-1",
    });

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issue?.executionRunId).toBe(wake?.runId);
    expect(issue?.executionAgentNameKey).toBe("coder");
    expect(issue?.executionLockedAt).not.toBeNull();

    const originalRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId))
      .then((rows) => rows[0]);
    expect(originalRun?.status).toBe("queued");
  });

  it("promotes a deferred issue-scoped wake for a non-assignee without taking the issue lock", async () => {
    const { companyId, agentId, queuedRunId } = await seed();
    const mentionedAgentId = randomUUID();
    const issueId = randomUUID();
    const deferredWakeId = randomUUID();
    await db.insert(agents).values({
      id: mentionedAgentId,
      companyId,
      name: "Mentioned Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Expired holder with cross-agent mention",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      checkoutRunId: null,
      executionRunId: queuedRunId,
      executionLockedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeId,
      companyId,
      agentId: mentionedAgentId,
      source: "comment",
      triggerDetail: "issue_comment_mentioned",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        commentId: "comment-mention",
        _paperclipWakeContext: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_comment_mentioned",
        },
      },
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      requestedAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        runId: agentWakeupRequests.runId,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId))
      .then((rows) => rows[0]);
    expect(wake).toMatchObject({
      status: "queued",
      error: null,
    });
    expect(wake?.runId).toBeTruthy();

    const promotedRun = await db
      .select({
        agentId: heartbeatRuns.agentId,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wake!.runId!))
      .then((rows) => rows[0]);
    expect(promotedRun).toMatchObject({
      agentId: mentionedAgentId,
      wakeupRequestId: deferredWakeId,
    });
    expect(promotedRun?.contextSnapshot).toMatchObject({
      issueId,
      taskId: issueId,
      wakeReason: "issue_comment_mentioned",
      commentId: "comment-mention",
    });

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issue).toEqual({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
  });

  it("fails non-invokable deferred wakes and promotes the next eligible wake", async () => {
    const { companyId, agentId, queuedRunId } = await seed();
    const pausedAgentId = randomUUID();
    const issueId = randomUUID();
    const pausedWakeId = randomUUID();
    const activeWakeId = randomUUID();
    await db.insert(agents).values({
      id: pausedAgentId,
      companyId,
      name: "Paused Coder",
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Expired holder with mixed deferred wakes",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: queuedRunId,
      executionLockedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });
    await db.insert(agentWakeupRequests).values([
      {
        id: pausedWakeId,
        companyId,
        agentId: pausedAgentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_execution_deferred",
        payload: { issueId, _paperclipWakeContext: { issueId, taskId: issueId } },
        status: "deferred_issue_execution",
        requestedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
      {
        id: activeWakeId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_execution_deferred",
        payload: { issueId, _paperclipWakeContext: { issueId, taskId: issueId } },
        status: "deferred_issue_execution",
        requestedAt: new Date(Date.now() - 5 * 60 * 1000),
      },
    ]);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    const wakes = await db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
        runId: agentWakeupRequests.runId,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.id} in (${pausedWakeId}, ${activeWakeId})`);
    const byId = new Map(wakes.map((wake) => [wake.id, wake]));
    expect(byId.get(pausedWakeId)).toMatchObject({
      status: "failed",
      runId: null,
      error: "Deferred wake could not be promoted: agent is not invokable",
    });
    expect(byId.get(activeWakeId)?.status).toBe("queued");
    expect(byId.get(activeWakeId)?.runId).toBeTruthy();
  });

  it("cancels deferred wake promotion when a subtree pause hold is active", async () => {
    const { companyId, agentId, queuedRunId } = await seed();
    const issueId = randomUUID();
    const deferredWakeId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Expired holder under pause hold",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: queuedRunId,
      executionLockedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: issueId,
      mode: "pause",
      status: "active",
      reason: "manual pause",
      releasePolicy: { strategy: "manual" },
      createdByActorType: "user",
      createdByUserId: "board-user",
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: { issueId, _paperclipWakeContext: { issueId, taskId: issueId } },
      status: "deferred_issue_execution",
      requestedByActorType: "system",
      requestedByActorId: null,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        runId: agentWakeupRequests.runId,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId))
      .then((rows) => rows[0]);
    expect(wake).toMatchObject({
      status: "cancelled",
      runId: null,
      error: "Deferred wake suppressed by active subtree pause hold",
    });

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issue).toEqual({ executionRunId: null, executionLockedAt: null });
  });

  // BLO-19941: `running` is neither missing nor terminal, so isCleanable() was
  // false forever and isPreClaimLockExpired() only covered queued/scheduled_retry.
  // A run whose row is wedged at `running` therefore held the issue lock
  // indefinitely and PATCH /api/issues/{id} returned 409 forever, with no
  // self-service escape for the assignee. reapOrphanedRuns is the primary path
  // but not a guarantee — several of its skips are clock-unbounded.
  async function seedWedgedRunningIssue(input: {
    companyId: string;
    agentId: string;
    // Most-recent genuine activity on the holder run.
    lastOutputAt: Date | null;
    lastUsefulActionAt?: Date | null;
    startedAt?: Date | null;
    lockedAt: Date;
    // The wedge shape claims checkout + execution together.
    sameRunHoldsCheckout?: boolean;
    updatedAt?: Date;
  }) {
    const wedgedRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: wedgedRunId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "running",
      invocationSource: "assignment",
      // `??` would collapse an explicit null into the default, which is exactly
      // the no-signal case these tests need to exercise.
      startedAt: "startedAt" in input ? input.startedAt : new Date(Date.now() - 8 * 60 * 60 * 1000),
      lastOutputAt: input.lastOutputAt,
      ...("lastUsefulActionAt" in input ? { lastUsefulActionAt: input.lastUsefulActionAt } : {}),
      ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Lock held by a run wedged at running",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: input.agentId,
      checkoutRunId: input.sameRunHoldsCheckout === false ? null : wedgedRunId,
      executionRunId: wedgedRunId,
      executionLockedAt: input.lockedAt,
    });
    return { wedgedRunId, issueId };
  }

  it("clears a lock whose holder has been running and silent past the bound (BLO-19941)", async () => {
    const { companyId, agentId } = await seed();
    const { wedgedRunId, issueId } = await seedWedgedRunningIssue({
      companyId,
      agentId,
      // Silent for 3h — past STALE_RUNNING_ISSUE_LOCK_MS (2h).
      lastOutputAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      lockedAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: null, executionRunId: null, executionLockedAt: null });

    // Clearing the lock is non-destructive: the run row itself is untouched.
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wedgedRunId))
      .then((rows) => rows[0]);
    expect(run?.status).toBe("running");

    const audit = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stale_lock_cleared"))
      .then((rows) => rows[0]);
    const details = audit?.details as
      | { reason?: string; runningLockTimeoutMs?: number; runningLockSilentMs?: number }
      | null;
    expect(details?.reason).toBe("running_lock_silent");
    expect(details?.runningLockTimeoutMs).toBe(2 * 60 * 60 * 1000);
    expect(details?.runningLockSilentMs).toBeGreaterThanOrEqual(3 * 60 * 60 * 1000);
  });

  it("preserves a holder whose useful-action stamp is stale but whose output is fresh (BLO-19848)", async () => {
    // The three activity columns are independent stamps, not a priority chain.
    // A `??` chain returns the FIRST non-null, so a 5h-old lastUsefulActionAt
    // masked a 1-minute-old lastOutputAt and classified a demonstrably live run
    // as silent — clearing the lock out from under it. Both the pre-transaction
    // scan and the in-transaction revalidation must select the NEWEST stamp.
    const { companyId, agentId } = await seed();
    const { wedgedRunId, issueId } = await seedWedgedRunningIssue({
      companyId,
      agentId,
      lastOutputAt: new Date(Date.now() - 60 * 1000),
      lastUsefulActionAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
      startedAt: new Date(Date.now() - 9 * 60 * 60 * 1000),
      lockedAt: new Date(Date.now() - 9 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: wedgedRunId, executionRunId: wedgedRunId });
  });

  it("still clears when every activity stamp is past the bound (BLO-19848)", async () => {
    // Companion to the test above: taking the max must not make the sweep
    // unreachable whenever lastUsefulActionAt happens to be populated.
    const { companyId, agentId } = await seed();
    const { issueId } = await seedWedgedRunningIssue({
      companyId,
      agentId,
      lastOutputAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      lastUsefulActionAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
      lockedAt: new Date(Date.now() - 9 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
  });

  it("preserves a long-running holder that is still producing output (BLO-19941)", async () => {
    // The bound must be measured from the run's own activity, never from
    // executionLockedAt: a healthy 8h run legitimately holds an 8h-old lock, and
    // keying on lock age would clear the locks of every long, healthy run.
    const { companyId, agentId } = await seed();
    const { wedgedRunId, issueId } = await seedWedgedRunningIssue({
      companyId,
      agentId,
      lastOutputAt: new Date(Date.now() - 60 * 1000),
      lockedAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: wedgedRunId, executionRunId: wedgedRunId });
  });

  it("preserves a running holder that is silent but still within the bound (BLO-19941)", async () => {
    const { companyId, agentId } = await seed();
    const { issueId } = await seedWedgedRunningIssue({
      companyId,
      agentId,
      // 30m of silence: the reaper owns this window, not the sweeper.
      lastOutputAt: new Date(Date.now() - 30 * 60 * 1000),
      lockedAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.executionRunId).not.toBeNull();
  });

  it("clears a silent running holder even while review churn bumps updatedAt (BLO-19941)", async () => {
    // BLO-8827: review/recovery churn bumps heartbeat_runs.updatedAt every
    // ~minute. Keying the bound on updatedAt would shield a dead run forever, so
    // the sweeper must ignore it entirely.
    const { companyId, agentId } = await seed();
    const { issueId } = await seedWedgedRunningIssue({
      companyId,
      agentId,
      lastOutputAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      lockedAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
      updatedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
  });

  it("falls back to lock age for a running holder with no activity signal (BLO-19941)", async () => {
    // A `running` row with no startedAt/lastOutputAt is also the shape of a run
    // mid-claim, so a freshly-taken lock must survive...
    const { companyId, agentId } = await seed();
    const fresh = await seedWedgedRunningIssue({
      companyId,
      agentId,
      lastOutputAt: null,
      startedAt: null,
      lockedAt: new Date(Date.now() - 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    expect((await heartbeat.sweepStaleIssueLocks()).cleared).toBe(0);
    const freshRow = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, fresh.issueId))
      .then((rows) => rows[0]);
    expect(freshRow?.executionRunId).toBe(fresh.wedgedRunId);

    // ...while one held past the bound with no signal at all is reclaimed.
    const stale = await seedWedgedRunningIssue({
      companyId,
      agentId,
      lastOutputAt: null,
      startedAt: null,
      lockedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
    const result = await heartbeat.sweepStaleIssueLocks();
    expect(result.issueIds).toEqual([stale.issueId]);
  });

  it("does not clear a live checkout lock held by a different run than the silent holder (BLO-19941)", async () => {
    // The checkout allowance is deliberately narrow: it is satisfied only when
    // the SAME wedged run holds both columns. A distinct, live checkout holder
    // keeps its lock no matter how silent the execution holder is.
    const { companyId, agentId, runningRunId } = await seed();
    const { issueId } = await seedWedgedRunningIssue({
      companyId,
      agentId,
      lastOutputAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      lockedAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
      sameRunHoldsCheckout: false,
    });
    await db
      .update(issues)
      .set({ checkoutRunId: runningRunId })
      .where(eq(issues.id, issueId));

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({ checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.checkoutRunId).toBe(runningRunId);
  });

  // BLO-19848: the BLO-18307 production shape. checkout and execution are
  // claimed together, so both columns name ONE run parked at `scheduled_retry`.
  // Before this fix nothing could clear it: isCleanable() is false for a
  // non-terminal status, the BLO-19941 `running`-silent allowance does not
  // apply, and so the loop `continue`d at the checkout guard on every 30s pass.
  // BLO-18307 stayed wedged ~1d7h with its fix already merged, returning 409 to
  // three close attempts by the assignee.
  async function seedWedgedScheduledRetryIssue(input: {
    companyId: string;
    agentId: string;
    lockedAt: Date;
    scheduledRetryAt: Date;
    scheduledRetryReason?: string | null;
    sameRunHoldsCheckout?: boolean;
    // Only the wake-driven case needs this: enqueueWakeup resolves a
    // responsible user before it can seed a run, and throws 422 without one.
    // Left null by default so the sweep-only cases keep their existing shape.
    responsibleUserId?: string | null;
  }) {
    const wedgedRunId = randomUUID();
    const issueId = randomUUID();
    const scheduledRetryReason = input.scheduledRetryReason ?? "ccrotate_capacity";
    await db.insert(heartbeatRuns).values({
      id: wedgedRunId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "scheduled_retry",
      invocationSource: "automation",
      startedAt: null,
      scheduledRetryAt: input.scheduledRetryAt,
      scheduledRetryAttempt: 1,
      scheduledRetryReason,
      contextSnapshot: { issueId, taskId: issueId, retryReason: scheduledRetryReason },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Lock held by a run parked at scheduled_retry",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: input.agentId,
      responsibleUserId: input.responsibleUserId ?? null,
      checkoutRunId: input.sameRunHoldsCheckout === false ? null : wedgedRunId,
      executionRunId: wedgedRunId,
      executionLockedAt: input.lockedAt,
    });
    return { wedgedRunId, issueId };
  }

  it("clears a lock whose scheduled_retry holder also holds the checkout column (BLO-19848)", async () => {
    const { companyId, agentId } = await seed();
    const { issueId } = await seedWedgedScheduledRetryIssue({
      companyId,
      agentId,
      lockedAt: new Date(Date.now() - 31 * 60 * 60 * 1000),
      // Retry deadline itself went stale 7h ago — past the 6h pre-claim bound.
      scheduledRetryAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
  });

  it("reclaims a scheduled_retry lock whose deadline is parked far in the future (BLO-21309)", async () => {
    // scheduledRetryAt is caller-supplied and re-parkable, so it cannot be the
    // staleness basis: a capacity retry pushed days out — and pushed again on
    // each re-park — would pin the lock forever, and while the basis is in the
    // future `now - basis` is negative so the bound never fires at all.
    // Staleness is therefore measured from executionLockedAt, exactly like the
    // `queued` branch.
    const { companyId, agentId } = await seed();
    const { issueId } = await seedWedgedScheduledRetryIssue({
      companyId,
      agentId,
      lockedAt: new Date(Date.now() - 13 * 60 * 60 * 1000),
      // Deadline still 3 days out: a deadline-relative bound could never fire.
      scheduledRetryAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    const row = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.executionRunId).toBeNull();
  });

  // BLO-22060: the cap the test above proves is renewable unless the release is
  // recorded on the run. The sweep deliberately leaves the parked run alive, and
  // enqueueWakeup's legacy-run fallback re-selected exactly that run —
  // cancelStaleScheduledRetry declines to cancel a park owned by the issue's own
  // assignee — then re-stamped executionLockedAt = now(). One wake restored the
  // full 6h window, so a capacity park deadlined days out kept the issue out of
  // service for its assignee indefinitely, in 6h slices rather than one block.
  it("does not let a wake re-adopt a parked retry whose lock the sweep already released (BLO-22060)", async () => {
    const { companyId, agentId } = await seed();
    const { issueId, wedgedRunId } = await seedWedgedScheduledRetryIssue({
      companyId,
      agentId,
      lockedAt: new Date(Date.now() - 13 * 60 * 60 * 1000),
      // Capacity parks take their horizon from the provider's reset, so the
      // deadline is routinely days out — the whole window this bug covers.
      scheduledRetryAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      sameRunHoldsCheckout: false,
      responsibleUserId: "responsible-user",
    });

    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });

    const sweep = await heartbeat.sweepStaleIssueLocks();
    expect(sweep.cleared).toBe(1);
    expect(sweep.issueIds).toContain(issueId);

    // The release is recorded on the run, because the issue columns it was
    // recorded on are exactly what the sweep just nulled.
    const releasedRun = await db
      .select({
        status: heartbeatRuns.status,
        issueLockReleaseCount: heartbeatRuns.issueLockReleaseCount,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wedgedRunId))
      .then((rows) => rows[0]);
    expect(releasedRun?.issueLockReleaseCount).toBe(1);
    // The park itself survives — the sweep releases the lock, it does not cancel
    // the retry, so the run still fires when its deadline arrives.
    expect(releasedRun?.status).toBe("scheduled_retry");

    // `manual` is user-initiated and so bypasses the ccrotate availability gate,
    // keeping this hermetic. The adoption path under test is shared by every
    // wake source.
    await heartbeat.enqueueWakeup(agentId, {
      source: "manual",
      reason: "issue_assigned",
      contextSnapshot: { issueId },
      payload: { issueId },
    });

    const afterWake = await db
      .select({
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);

    // The core assertion: the burnt-out park is not the holder again. Before the
    // fix this was `wedgedRunId` with a brand-new executionLockedAt.
    expect(afterWake?.executionRunId).not.toBe(wedgedRunId);
    // And the sweep's release stays effective: nothing re-armed a 6h window on
    // behalf of the run that just lost one.
    const reReleasedRun = await db
      .select({ issueLockReleaseCount: heartbeatRuns.issueLockReleaseCount })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wedgedRunId))
      .then((rows) => rows[0]);
    expect(reReleasedRun?.issueLockReleaseCount).toBe(1);

    // Idempotent under wake volume: the bound is on the run, not on the wake, so
    // repeat wakes cannot walk it back.
    await heartbeat.enqueueWakeup(agentId, {
      source: "manual",
      reason: "issue_assigned",
      contextSnapshot: { issueId },
      payload: { issueId },
    });
    const afterSecondWake = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(afterSecondWake?.executionRunId).not.toBe(wedgedRunId);
  });

  // BLO-22060 review follow-up: the bound must not be status-scoped. The sweep
  // releases — and counts — three shapes of holder, and enqueueWakeup's
  // legacy-run fallback selects all three via
  // EXECUTION_PATH_HEARTBEAT_RUN_STATUSES. Scoping the predicate to
  // `scheduled_retry` left the *original* renewable shape (BLO-18995's never-
  // claimed `queued` lock) and BLO-19941's silent-`running` lock re-adoptable on
  // every wake, and let a released park evade the bound outright by being
  // promoted — promotion flips the run to `queued`, carrying its release count
  // across, so a status-scoped predicate stopped applying to the same row.
  async function seedSweptAdoptableIssue(input: {
    companyId: string;
    agentId: string;
    status: "queued" | "running" | "scheduled_retry";
    lockedAt: Date;
    // `running` holders are bounded on their own most-recent activity, never on
    // the lock timestamp — see runningLockStaleBasis.
    lastSignalAt?: Date;
    scheduledRetryAt?: Date;
  }) {
    const wedgedRunId = randomUUID();
    const issueId = randomUUID();
    const runningSignal = input.status === "running" ? (input.lastSignalAt ?? null) : null;
    await db.insert(heartbeatRuns).values({
      id: wedgedRunId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      invocationSource: "automation",
      startedAt: runningSignal,
      lastOutputAt: runningSignal,
      lastUsefulActionAt: runningSignal,
      ...(input.status === "scheduled_retry"
        ? {
            scheduledRetryAt: input.scheduledRetryAt ?? new Date(Date.now() - 60_000),
            scheduledRetryAttempt: 1,
            // Deliberately not one of the reasons in
            // SCHEDULED_RETRY_REASONS_REQUIRING_CONTINUOUS_ISSUE_LOCK, which the
            // sweep refuses to release at all.
            scheduledRetryReason: "ccrotate_capacity",
          }
        : {}),
      // The fallback matches candidates on this. A run without it is not an
      // adoption candidate at all, which would make the assertions vacuous.
      contextSnapshot: { issueId, taskId: issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: `Lock held by a run at ${input.status}`,
      status: "in_progress",
      priority: "high",
      assigneeAgentId: input.agentId,
      // enqueueWakeup resolves a responsible user before it can seed a run.
      responsibleUserId: "responsible-user",
      checkoutRunId: null,
      executionRunId: wedgedRunId,
      executionLockedAt: input.lockedAt,
    });
    return { wedgedRunId, issueId };
  }

  it("does not let a wake re-adopt a never-claimed queued run whose lock the sweep released (BLO-22060)", async () => {
    // The BLO-18995 shape: four enqueue paths stamp the lock at enqueue time
    // alongside a freshly-inserted `queued` run. If that run is never claimed the
    // sweep is the only thing that releases it — and re-adoption here restored
    // the full 6h window, so the issue was never actually freed for its assignee.
    const { companyId, agentId } = await seed();
    const { issueId, wedgedRunId } = await seedSweptAdoptableIssue({
      companyId,
      agentId,
      status: "queued",
      lockedAt: new Date(Date.now() - 13 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });

    const sweep = await heartbeat.sweepStaleIssueLocks();
    expect(sweep.cleared).toBe(1);
    expect(sweep.issueIds).toContain(issueId);

    // Non-vacuity: the release is counted for a `queued` holder too, and the run
    // is still alive and therefore still selectable by the fallback.
    const released = await db
      .select({
        status: heartbeatRuns.status,
        issueLockReleaseCount: heartbeatRuns.issueLockReleaseCount,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wedgedRunId))
      .then((rows) => rows[0]);
    expect(released?.status).toBe("queued");
    expect(released?.issueLockReleaseCount).toBe(1);

    await heartbeat.enqueueWakeup(agentId, {
      source: "manual",
      reason: "issue_assigned",
      contextSnapshot: { issueId },
      payload: { issueId },
    });

    const afterWake = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(afterWake?.executionRunId).not.toBe(wedgedRunId);
  });

  it("does not let a wake re-adopt a silent running run whose lock the sweep released (BLO-22060)", async () => {
    // BLO-19941's shape. Re-adopting a holder the sweep has already declared
    // silent re-wedges the issue behind a run nothing is driving.
    const { companyId, agentId } = await seed();
    const { issueId, wedgedRunId } = await seedSweptAdoptableIssue({
      companyId,
      agentId,
      status: "running",
      lockedAt: new Date(Date.now() - 9 * 60 * 60 * 1000),
      // Every activity stamp well past STALE_RUNNING_ISSUE_LOCK_MS (2h).
      lastSignalAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });

    const sweep = await heartbeat.sweepStaleIssueLocks();
    expect(sweep.cleared).toBe(1);
    expect(sweep.issueIds).toContain(issueId);

    const released = await db
      .select({
        status: heartbeatRuns.status,
        issueLockReleaseCount: heartbeatRuns.issueLockReleaseCount,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wedgedRunId))
      .then((rows) => rows[0]);
    expect(released?.status).toBe("running");
    expect(released?.issueLockReleaseCount).toBe(1);

    await heartbeat.enqueueWakeup(agentId, {
      source: "manual",
      reason: "issue_assigned",
      contextSnapshot: { issueId },
      payload: { issueId },
    });

    const afterWake = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(afterWake?.executionRunId).not.toBe(wedgedRunId);
  });

  it("does not let a released park evade the bound by being promoted to queued (BLO-22060)", async () => {
    // The status-transition hole. The park is released and counted while it is
    // `scheduled_retry`, then promoteDueScheduledRetries flips the same row to
    // `queued`. A predicate keyed on status stopped applying at that point, so
    // the next wake re-adopted the run and re-stamped executionLockedAt — the
    // bound was one promotion away from being renewable again.
    const { companyId, agentId } = await seed();
    const { issueId, wedgedRunId } = await seedSweptAdoptableIssue({
      companyId,
      agentId,
      status: "scheduled_retry",
      lockedAt: new Date(Date.now() - 13 * 60 * 60 * 1000),
      // Due, so promotion below is real rather than simulated by a status poke.
      scheduledRetryAt: new Date(Date.now() - 60_000),
    });

    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });

    const sweep = await heartbeat.sweepStaleIssueLocks();
    expect(sweep.cleared).toBe(1);
    expect(sweep.issueIds).toContain(issueId);

    const promotion = await heartbeat.promoteDueScheduledRetries(new Date());
    expect(promotion.runIds).toContain(wedgedRunId);

    // The release count survives the status transition — that is what lets the
    // bound keep applying to a row that is no longer a `scheduled_retry`.
    const promoted = await db
      .select({
        status: heartbeatRuns.status,
        issueLockReleaseCount: heartbeatRuns.issueLockReleaseCount,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wedgedRunId))
      .then((rows) => rows[0]);
    expect(promoted?.status).toBe("queued");
    expect(promoted?.issueLockReleaseCount).toBe(1);

    await heartbeat.enqueueWakeup(agentId, {
      source: "manual",
      reason: "issue_assigned",
      contextSnapshot: { issueId },
      payload: { issueId },
    });

    const afterWake = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(afterWake?.executionRunId).not.toBe(wedgedRunId);
  });

  it.each([
    "max_turns_continuation",
    "capacity_blocked",
    "job_failed",
  ])("preserves and promotes lock-required scheduled_retry holders (%s)", async (scheduledRetryReason) => {
    const { companyId, agentId } = await seed();
    const { issueId, wedgedRunId } = await seedWedgedScheduledRetryIssue({
      companyId,
      agentId,
      lockedAt: new Date(Date.now() - 13 * 60 * 60 * 1000),
      scheduledRetryAt: new Date(Date.now() - 60_000),
      scheduledRetryReason,
    });

    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
    const sweep = await heartbeat.sweepStaleIssueLocks();

    expect(sweep.cleared).toBe(0);
    const locked = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(locked?.executionRunId).toBe(wedgedRunId);

    const promotion = await heartbeat.promoteDueScheduledRetries(new Date());
    expect(promotion.runIds).toContain(wedgedRunId);
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wedgedRunId))
      .then((rows) => rows[0]);
    expect(run?.status).toBe("queued");
  });

  it("re-reads running-holder output inside the sweep transaction before clearing (BLO-19848)", async () => {
    // Transaction-path companion to the timestamp-ordering regression. The
    // holder looks silent to the pre-transaction scan, then emits output while
    // the sweep is in flight — leaving lastUsefulActionAt stale. The
    // in-transaction revalidation must select the newest stamp too, or it
    // clears the lock of a run that just proved it is alive.
    const { companyId, agentId } = await seed();
    const { issueId, wedgedRunId } = await seedWedgedRunningIssue({
      companyId,
      agentId,
      lastOutputAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      lastUsefulActionAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
      lockedAt: new Date(Date.now() - 9 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db, {
      beforeStaleIssueLockSweepClearForTest: async (issue) => {
        if (issue.id !== issueId) return;
        await db
          .update(heartbeatRuns)
          .set({ lastOutputAt: new Date() })
          .where(eq(heartbeatRuns.id, wedgedRunId));
      },
    });
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.checkoutRunId).toBe(wedgedRunId);
    expect(row?.executionRunId).toBe(wedgedRunId);
    expect(row?.executionLockedAt).not.toBeNull();
  });

  it("re-reads run state inside the sweep transaction before clearing (BLO-19848)", async () => {
    // The decision must be made on the row as it exists under FOR UPDATE, not on
    // the pre-transaction snapshot. The realistic race is the one the sweep
    // exists to handle: a parked holder is promoted and starts running while the
    // sweep is already in flight. Re-reading sees a live holder and declines;
    // trusting the snapshot would strip the lock out from under a running run.
    const { companyId, agentId } = await seed();
    const { issueId, wedgedRunId } = await seedWedgedScheduledRetryIssue({
      companyId,
      agentId,
      lockedAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
      scheduledRetryAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db, {
      beforeStaleIssueLockSweepClearForTest: async (issue) => {
        if (issue.id !== issueId) return;
        await db
          .update(heartbeatRuns)
          .set({ status: "running", lastOutputAt: new Date() })
          .where(eq(heartbeatRuns.id, wedgedRunId));
      },
    });
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.checkoutRunId).toBe(wedgedRunId);
    expect(row?.executionRunId).toBe(wedgedRunId);
    expect(row?.executionLockedAt).not.toBeNull();
  });

  it("does not clear a scheduled_retry lock held by a different live checkout run (BLO-19848)", async () => {
    // The same-run restriction is what makes the checkout allowance safe. A
    // distinct live checkout holder must keep its lock however stale the
    // execution holder is.
    const { companyId, agentId, runningRunId } = await seed();
    const { issueId } = await seedWedgedScheduledRetryIssue({
      companyId,
      agentId,
      lockedAt: new Date(Date.now() - 31 * 60 * 60 * 1000),
      scheduledRetryAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
      sameRunHoldsCheckout: false,
    });
    await db
      .update(issues)
      .set({ checkoutRunId: runningRunId })
      .where(eq(issues.id, issueId));

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({ checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.checkoutRunId).toBe(runningRunId);
  });
});
