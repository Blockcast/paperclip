/**
 * BLO-21621: a queued heartbeat run can detach from its source issue and
 * never start. The lazy-locking model only stamps `issues.executionRunId`
 * at claim time, so a plain queued run is normally unlocked -- that alone is
 * not a defect. The defect is a run that is *both* stale (queued well past
 * any normal dispatch cadence) *and* detached (its issue's checkout/execution
 * lock no longer names it). Once detached, nothing else in the recovery
 * apparatus re-examines that specific row: every sweep built on
 * hasActiveExecutionPath treats any queued row referencing the issue as
 * proof of life, with no staleness check.
 *
 * heartbeat.reconcileDetachedQueuedRuns() is the backstop: it terminalizes a
 * stale + detached queued run and, only when nothing else owns the issue's
 * lock, fires exactly one recovery wake so the assignee gets a clean shot.
 *
 * Deliberately keyed on detachment, not age alone -- a run that is still the
 * issue's recognized lock holder must be left alone no matter how long it has
 * been queued, since that is the shape of an agent legitimately saturated at
 * its concurrency ceiling.
 */
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres detached-queued-run reconciliation tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const SEVEN_HOURS_MS = 7 * 60 * 60 * 1000;

describeEmbeddedPostgres("heartbeat reconcileDetachedQueuedRuns", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-detached-queued-run-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 120_000);

  afterEach(async () => {
    await cleanupHeartbeatTestState(db, heartbeat, {
      errorLabel: "detached-queued-run reconciliation test cleanup",
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5, concurrencyEnabled: true },
      },
      permissions: {},
    });

    return { companyId, agentId };
  }

  it("terminalizes a stale queued run whose issue lock is empty, and fires exactly one recovery wake (BLO-21621)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const staleRunId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Detached queued run — no owner at all",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
    });
    await db.insert(heartbeatRuns).values({
      id: staleRunId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "on_demand",
      contextSnapshot: { issueId, wakeReason: "issue_continuation_needed" },
      createdAt: new Date(Date.now() - SEVEN_HOURS_MS),
    });

    const result = await heartbeat.reconcileDetachedQueuedRuns();

    expect(result).toMatchObject({ scanned: 1, terminalized: 1, recovered: 1, skipped: 0, failed: 0 });

    const staleRun = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, staleRunId))
      .then((rows) => rows[0]);
    expect(staleRun).toEqual({ status: "cancelled", errorCode: "queued_run_detached_from_issue" });

    // Exactly one fresh, live run now exists for the issue -- the detached
    // row was replaced, not duplicated alongside a second live attempt.
    const runsForIssue = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
      ));
    expect(runsForIssue).toHaveLength(2);
    const freshRun = runsForIssue.find((row) => row.id !== staleRunId);
    expect(freshRun?.status).not.toBe("cancelled");
  });

  it("leaves a queued run alone when it is still the issue's recognized lock holder, no matter how old (BLO-21621)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const attachedRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: attachedRunId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "on_demand",
      contextSnapshot: { issueId },
      createdAt: new Date(Date.now() - SEVEN_HOURS_MS),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Still attached — legitimately queued behind a full slot pool",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: attachedRunId,
      executionLockedAt: new Date(Date.now() - SEVEN_HOURS_MS),
    });

    const result = await heartbeat.reconcileDetachedQueuedRuns();

    expect(result).toMatchObject({ scanned: 1, terminalized: 0, recovered: 0, skipped: 1, failed: 0 });

    const attachedRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, attachedRunId))
      .then((rows) => rows[0]);
    expect(attachedRun?.status).toBe("queued");

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issue?.executionRunId).toBe(attachedRunId);
  });

  it("terminalizes a stale detached run without re-waking when another live run already owns the issue (BLO-21621)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const staleOrphanRunId = randomUUID();
    const liveOwnerRunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      {
        id: staleOrphanRunId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "on_demand",
        contextSnapshot: { issueId },
        createdAt: new Date(Date.now() - SEVEN_HOURS_MS),
      },
      {
        id: liveOwnerRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "on_demand",
        contextSnapshot: { issueId },
        startedAt: new Date(),
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Superseded by a newer live run",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: liveOwnerRunId,
      executionLockedAt: new Date(),
    });

    const result = await heartbeat.reconcileDetachedQueuedRuns();

    expect(result).toMatchObject({ scanned: 1, terminalized: 1, recovered: 0, skipped: 0, failed: 0 });

    const rows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === staleOrphanRunId)?.status).toBe("cancelled");
    expect(rows.find((row) => row.id === liveOwnerRunId)?.status).toBe("running");

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows2) => rows2[0]);
    expect(issue?.executionRunId).toBe(liveOwnerRunId);
  });
});
