/**
 * BLO-33539: an armed monitor on a status-ineligible issue can never fire, and
 * nothing re-examines it.
 *
 * `tickDueIssueMonitors` only ever *selects* eligible rows — agent-assigned,
 * `in_progress`/`in_review`. A row demoted out of that set keeps a populated
 * `monitorNextCheckAt` and reads `scheduled` forever while being structurally
 * incapable of firing. Three transition-time fixes (checkout-restore, raw
 * assignee demotion, bulk user removal) each clear the monitor at the instant
 * of one specific demotion, but a producer none of them covers reintroduces the
 * defect for free: BLO-22498 was parked `in_progress` -> `blocked` by
 * `workspace_validation` recovery 2m37s before its monitor was due, on a gate
 * that had ALREADY gone green, and sat dead for two days.
 *
 * This reconciler is the producer-agnostic backstop. It never grants a wake —
 * an ineligible issue still gets nothing — it only stops the dead monitor
 * claiming to be scheduled, and records what it was watching.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issues } from "@paperclipai/db";
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
    `Skipping embedded Postgres undeliverable-monitor reconciliation tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const MONITOR_NOTES = "gate=pr:Blockcast/paperclip#1734:merged; automated gate, not human-only";

describeEmbeddedPostgres("heartbeat reconcileUndeliverableIssueMonitors", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-undeliverable-monitor-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
  }, 120_000);

  afterEach(async () => {
    await cleanupHeartbeatTestState(db, heartbeat, {
      errorLabel: "undeliverable-monitor reconciliation test cleanup",
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(companyStatus = "active") {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: companyStatus,
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

  /** An `in_progress`, agent-assigned row holding a live armed monitor. */
  async function seedArmedIssue(
    companyId: string,
    assigneeAgentId: string | null,
    nextCheckAt: Date,
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Armed monitor watching an automated gate",
      status: "in_progress",
      priority: "high",
      assigneeAgentId,
      executionPolicy: {
        monitor: {
          nextCheckAt: nextCheckAt.toISOString(),
          scheduledBy: "assignee",
          notes: MONITOR_NOTES,
        },
      },
      monitorNextCheckAt: nextCheckAt,
      monitorNotes: MONITOR_NOTES,
      monitorScheduledBy: "assignee",
      monitorAttemptCount: 2,
    });
    return issueId;
  }

  function readIssue(issueId: string) {
    return db
      .select({
        status: issues.status,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorNotes: issues.monitorNotes,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
  }

  it("clears a monitor stranded by a raw status park, and keeps the notes readable (BLO-33539)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const dueAt = new Date(Date.now() - 60 * 60 * 1000);
    const issueId = await seedArmedIssue(companyId, agentId, dueAt);

    // The recovery park: a raw status write that bypasses the policy transition
    // entirely, so no transition-time guard runs. This is the BLO-22498 shape.
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));

    const result = await heartbeat.reconcileUndeliverableIssueMonitors();
    expect(result).toMatchObject({ scanned: 1, cleared: 1, skipped: 0, failed: 0 });

    const row = await readIssue(issueId);
    // The dead monitor no longer claims to be scheduled...
    expect(row.monitorNextCheckAt).toBeNull();
    expect((row.executionState as { monitor?: { status?: string; clearReason?: string } }).monitor)
      .toMatchObject({ status: "cleared", clearReason: "invalid_status" });
    // ...and what it was watching survives on the issue.
    expect((row.executionState as { monitor?: { notes?: string } }).monitor?.notes).toBe(MONITOR_NOTES);
    // The issue is NOT promoted back into an eligible state: clearing a dead
    // monitor must never hand out the wake the monitor could not deliver.
    expect(row.status).toBe("blocked");

    const logged = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ action: "issue.monitor_cleared_undeliverable" });
    expect(logged[0]!.details).toMatchObject({ clearReason: "invalid_status", notes: MONITOR_NOTES });
  });

  it("clears a monitor stranded by assignee removal", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedArmedIssue(companyId, agentId, new Date(Date.now() - 60 * 60 * 1000));
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, issueId));

    const result = await heartbeat.reconcileUndeliverableIssueMonitors();
    expect(result).toMatchObject({ scanned: 1, cleared: 1 });

    const row = await readIssue(issueId);
    expect(row.monitorNextCheckAt).toBeNull();
    expect((row.executionState as { monitor?: { clearReason?: string } }).monitor)
      .toMatchObject({ clearReason: "invalid_assignee" });
  });

  it("leaves a deliverable monitor alone, due or not", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const overdue = await seedArmedIssue(companyId, agentId, new Date(Date.now() - 60 * 60 * 1000));
    const future = await seedArmedIssue(companyId, agentId, new Date(Date.now() + 60 * 60 * 1000));

    const result = await heartbeat.reconcileUndeliverableIssueMonitors();
    expect(result).toMatchObject({ scanned: 0, cleared: 0 });

    // An overdue monitor on an ELIGIBLE row is the scheduler's to dispatch, not
    // this sweep's to clear. Reaping it here would delete live work.
    expect((await readIssue(overdue)).monitorNextCheckAt).not.toBeNull();
    expect((await readIssue(future)).monitorNextCheckAt).not.toBeNull();
  });

  it("leaves an archived company's monitors alone", async () => {
    // `tickDueIssueMonitors` also requires companies.status = 'active', so these
    // monitors cannot fire either — but the cause is the company, not the row.
    // Clearing them would destroy live state that resumes if the company does.
    const { companyId, agentId } = await seedCompanyAndAgent("archived");
    const issueId = await seedArmedIssue(companyId, agentId, new Date(Date.now() - 60 * 60 * 1000));
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));

    const result = await heartbeat.reconcileUndeliverableIssueMonitors();
    expect(result).toMatchObject({ scanned: 0, cleared: 0 });
    expect((await readIssue(issueId)).monitorNextCheckAt).not.toBeNull();
  });

  it("skips a row that was re-armed between the read and the write", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const dueAt = new Date(Date.now() - 60 * 60 * 1000);
    const issueId = await seedArmedIssue(companyId, agentId, dueAt);
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));

    // Simulate a concurrent checkout landing after the candidate scan: the CAS
    // on (status, monitorNextCheckAt) must decline, or this sweep deletes the
    // fresh monitor and causes the stall it exists to prevent.
    const result = await heartbeat.reconcileUndeliverableIssueMonitors({
      beforeClear: async () => {
        await db
          .update(issues)
          .set({ status: "in_progress", monitorNextCheckAt: new Date(Date.now() + 30 * 60 * 1000) })
          .where(eq(issues.id, issueId));
      },
    });

    expect(result).toMatchObject({ scanned: 1, cleared: 0, skipped: 1, failed: 0 });
    expect((await readIssue(issueId)).monitorNextCheckAt).not.toBeNull();
  });

  // The sibling above moves status AND nextCheckAt, so a CAS on just those two
  // declines and the test passes either way. This one is the narrow case it
  // cannot reach, and the one Ally raised: eligibility is the TUPLE (status,
  // assigneeAgentId, assigneeUserId), so a row ineligible only for being
  // unassigned goes deliverable on an assignee write ALONE — status stays
  // `in_progress`, nextCheckAt never moves. A CAS on (status, nextCheckAt)
  // therefore waves it through and this sweep deletes the monitor a checkout
  // just armed, which is precisely the stall it exists to prevent. Red before
  // the assignee predicates joined the CAS: cleared 1, monitorNextCheckAt null.
  it("skips a row that was re-assigned between the read and the write", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const dueAt = new Date(Date.now() - 60 * 60 * 1000);
    // Ineligible for the unassigned reason ONLY — already `in_progress`.
    const issueId = await seedArmedIssue(companyId, null, dueAt);

    const result = await heartbeat.reconcileUndeliverableIssueMonitors({
      beforeClear: async () => {
        await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, issueId));
      },
    });

    expect(result).toMatchObject({ scanned: 1, cleared: 0, skipped: 1, failed: 0 });
    const row = await readIssue(issueId);
    expect(row.monitorNextCheckAt?.toISOString()).toBe(dueAt.toISOString());
    expect((row.executionState as { monitor?: unknown } | null)?.monitor).toBeUndefined();
  });
});
