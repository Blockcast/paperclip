/**
 * PEN-5346: a cancel destroys the assignee's armed monitor and tells nobody.
 *
 * `reconcileUndeliverableIssueMonitors` clears a monitor that a cancel made
 * undeliverable — correctly, a cancelled row cannot fire. But the wake it
 * destroys is frequently the only observer the row had between runs, so the
 * destruction removes the very thing that would have noticed it. Measured on
 * two live alertmanager rows: 14 of 14 `clearReason: "cancelled"` clears paired
 * with a plugin cancel seconds earlier, every one destroyed before its due
 * time, 8 of 10 at `attemptCount: 0` so the loss raises no budget signal.
 *
 * `reconcileCancelledIssueMonitorRecoveries` is the handoff. It keys on the
 * cancel — which always happens — rather than on a reopen, which may not, so it
 * covers both branches:
 *
 *  - FLAPPING: the alert re-fires, the row is reopened to `todo` with no
 *    monitor. The residue is still there and the handoff still lands.
 *  - TERMINAL: the alert resolved for good and nothing reopens the row, which
 *    is exactly when the row's other obligations (an open remediation PR it
 *    solely owns) die with it.
 *
 * The suite also pins the second disjunct, PEN-3554 — `status: "cancelled"`
 * with a live `monitorNextCheckAt` — which selects zero live rows today. That
 * is the point: a predicate with no instances is the cheapest one to pin.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issueComments, issues } from "@paperclipai/db";
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
    `Skipping embedded Postgres cancelled-monitor recovery tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const MONITOR_NOTES = "Waiting on a human merge of onprem-k8s#7360; the alert cleared because that PR exists.";
const GATE_SIGNALS = ["pr:blockcast/onprem-k8s#7360:merged"];
const CLEARED_AT = "2026-11-03T01:11:39.000Z";

type MonitorResidue = {
  status?: string;
  clearReason?: string;
  clearedAt?: string | null;
  recoveryEmittedAt?: string | null;
  notes?: string | null;
};

describeEmbeddedPostgres("heartbeat reconcileCancelledIssueMonitorRecoveries", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cancelled-monitor-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
  }, 120_000);

  afterEach(async () => {
    await cleanupHeartbeatTestState(db, heartbeat, {
      errorLabel: "cancelled-monitor recovery test cleanup",
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
      name: "Devops",
      role: "devops",
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

  /**
   * The row as `buildIssueMonitorClearedPatch` leaves it after a cancel: live
   * columns empty, the whole record of what was owed on the audit copy. Note
   * `monitorNotes` is deliberately null — PEN-1995 nulls the column on every
   * clear, which is why the handoff has to read the audit copy instead.
   */
  async function seedCancelledResidue(
    companyId: string,
    assigneeAgentId: string | null,
    overrides: {
      status?: string;
      clearReason?: string;
      recoveryPolicy?: string | null;
      recoveryEmittedAt?: string | null;
      monitorNextCheckAt?: Date | null;
    } = {},
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "[Alert] node-exporter down on prod-07",
      status: overrides.status ?? "cancelled",
      priority: "high",
      assigneeAgentId,
      originKind: "plugin:paperclip-plugin-alertmanager",
      executionPolicy: null,
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "cleared",
          nextCheckAt: null,
          lastTriggeredAt: null,
          attemptCount: 0,
          notes: MONITOR_NOTES,
          scheduledBy: "assignee",
          gateSignals: GATE_SIGNALS,
          gateFingerprint: null,
          gateSource: "gates",
          convergenceCount: 0,
          convergenceStallCount: 0,
          convergenceStalledAssigneeAgentId: null,
          kind: "external_service",
          serviceName: "github",
          externalRef: null,
          timeoutAt: null,
          maxAttempts: null,
          recoveryPolicy: overrides.recoveryPolicy === undefined ? "wake_owner" : overrides.recoveryPolicy,
          clearedAt: CLEARED_AT,
          clearReason: overrides.clearReason ?? "cancelled",
          ...(overrides.recoveryEmittedAt === undefined ? {} : { recoveryEmittedAt: overrides.recoveryEmittedAt }),
        },
      },
      monitorNextCheckAt: overrides.monitorNextCheckAt ?? null,
      monitorNotes: null,
      monitorScheduledBy: "assignee",
      monitorAttemptCount: 0,
      cancelledAt: (overrides.status ?? "cancelled") === "cancelled" ? new Date(CLEARED_AT) : null,
    });
    return issueId;
  }

  function readIssue(issueId: string) {
    return db
      .select({
        status: issues.status,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]!);
  }

  function residueOf(executionState: unknown): MonitorResidue {
    return ((executionState as { monitor?: MonitorResidue } | null)?.monitor ?? {}) as MonitorResidue;
  }

  function readRecoveryIssues(issueId: string) {
    return db
      .select({
        id: issues.id,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        priority: issues.priority,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        originKind: issues.originKind,
        originFingerprint: issues.originFingerprint,
      })
      .from(issues)
      .where(and(eq(issues.originId, issueId), eq(issues.originKind, "stranded_issue_recovery")));
  }

  it("hands a terminally-cancelled row's obligation to a surviving carrier (PEN-5346)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledResidue(companyId, agentId);

    const result = await heartbeat.reconcileCancelledIssueMonitorRecoveries();
    expect(result).toMatchObject({ scanned: 1, recovered: 1, cleared: 0, skipped: 0, failed: 0 });

    // The carrier exists, is live, and is a ROW — not a comment on a cancelled
    // thread nobody will open again.
    const recoveries = await readRecoveryIssues(issueId);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]).toMatchObject({
      status: "todo",
      priority: "high",
      parentId: issueId,
      assigneeAgentId: agentId,
      originFingerprint: "issue_monitor:cancelled",
    });
    expect(recoveries[0]!.title).toContain("Carry forward the wake cancelled on");

    // It carries the whole record of what was owed. The notes came off the
    // audit copy: the live column was nulled by the clear.
    const body = recoveries[0]!.description ?? "";
    expect(body).toContain(MONITOR_NOTES);
    expect(body).toContain(GATE_SIGNALS[0]!);
    expect(body).toContain(CLEARED_AT);
    expect(body).toContain("solely owns an open work product");
    // The reason must not be mislabelled as attempt exhaustion (BLO-29606).
    expect(body).toContain("was cancelled while a wake was still owed");
    expect(body).not.toContain("maximum attempt count");

    // The source row keeps its terminal status: a handoff never un-cancels.
    const source = await readIssue(issueId);
    expect(source.status).toBe("cancelled");
    expect(residueOf(source.executionState).recoveryEmittedAt).toBeTruthy();

    const actions = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(actions).toContain("issue.monitor_recovery_issue_created");
  });

  it("hands back on a REOPENED row too — the flapping branch (PEN-5335 shape)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // The plugin cancelled, the clear landed, then the alert re-fired and the
    // row came back to `todo` with no monitor. The residue is what is left of
    // the wake, and the agent working this row is owed it.
    const issueId = await seedCancelledResidue(companyId, agentId, { status: "todo" });

    const result = await heartbeat.reconcileCancelledIssueMonitorRecoveries();
    expect(result).toMatchObject({ scanned: 1, recovered: 1, failed: 0 });

    expect(await readRecoveryIssues(issueId)).toHaveLength(1);
    const source = await readIssue(issueId);
    expect(source.status).toBe("todo");
    expect(residueOf(source.executionState).recoveryEmittedAt).toBeTruthy();
  });

  it("forces create_recovery_issue over the configured policy, including a null one", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // 12 of the 17 rows in the measured population carry `recoveryPolicy: null`
    // and 5 carry `wake_owner`; NONE carries `create_recovery_issue`. Honouring
    // the configured policy is a no-op on the first group and a comment onto a
    // cancelled row on the second, so it reproduces the bug on every row.
    const nullPolicy = await seedCancelledResidue(companyId, agentId, { recoveryPolicy: null });
    const wakeOwner = await seedCancelledResidue(companyId, agentId, { recoveryPolicy: "wake_owner" });

    const result = await heartbeat.reconcileCancelledIssueMonitorRecoveries();
    expect(result).toMatchObject({ scanned: 2, recovered: 2, failed: 0 });

    expect(await readRecoveryIssues(nullPolicy)).toHaveLength(1);
    expect(await readRecoveryIssues(wakeOwner)).toHaveLength(1);
    // `wake_owner` would have put the whole artifact on the cancelled thread.
    for (const issueId of [nullPolicy, wakeOwner]) {
      const comments = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(0);
    }
  });

  it("is idempotent: a second pass does not select an already-handed-back row", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledResidue(companyId, agentId);

    await heartbeat.reconcileCancelledIssueMonitorRecoveries();
    const second = await heartbeat.reconcileCancelledIssueMonitorRecoveries();

    expect(second).toMatchObject({ scanned: 0, recovered: 0, failed: 0 });
    expect(await readRecoveryIssues(issueId)).toHaveLength(1);
  });

  it("self-heals a crash between the emit and the stamp without duplicating the carrier", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledResidue(companyId, agentId);

    await heartbeat.reconcileCancelledIssueMonitorRecoveries();

    // The shape a crash after the recovery commit but before the stamp leaves.
    // Emitting first and stamping second is what makes this the SAFE direction
    // to fail in: the obligation is re-offered, never silently discharged.
    const row = await readIssue(issueId);
    const residue = residueOf(row.executionState);
    await db
      .update(issues)
      .set({
        executionState: {
          ...(row.executionState as Record<string, unknown>),
          monitor: { ...residue, recoveryEmittedAt: null },
        },
      })
      .where(eq(issues.id, issueId));

    const replay = await heartbeat.reconcileCancelledIssueMonitorRecoveries();
    expect(replay).toMatchObject({ scanned: 1, recovered: 1, failed: 0 });

    // One carrier, not two: `findOpenIssueMonitorRecoveryIssue` reuses the open
    // row, and the stamp lands this time.
    expect(await readRecoveryIssues(issueId)).toHaveLength(1);
    expect(residueOf((await readIssue(issueId)).executionState).recoveryEmittedAt).toBeTruthy();
  });

  it("nulls a live monitor column on a cancelled row AND hands it back, in one pass (PEN-3554)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // The second disjunct: a cancel that landed between the monitor claim and
    // `enqueueWakeup`, leaving a terminal row advertising a live wake. Zero live
    // instances in PEN today — pinned here while it is free to pin.
    const dueAt = new Date("2026-11-04T12:30:00.000Z");
    const issueId = await seedCancelledResidue(companyId, agentId, {
      clearReason: "max_attempts_exhausted",
      monitorNextCheckAt: dueAt,
    });

    const result = await heartbeat.reconcileCancelledIssueMonitorRecoveries();
    expect(result).toMatchObject({ scanned: 1, cleared: 1, recovered: 1, failed: 0 });

    const row = await readIssue(issueId);
    // Exactly one well-defined state: cleared, with no column claiming a wake.
    expect(row.monitorNextCheckAt).toBeNull();
    expect(residueOf(row.executionState)).toMatchObject({ status: "cleared", clearReason: "cancelled" });
    expect(residueOf(row.executionState).recoveryEmittedAt).toBeTruthy();
    // And the same recovery the other disjunct emits.
    expect(await readRecoveryIssues(issueId)).toHaveLength(1);

    const actions = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(actions).toContain("issue.monitor_cleared_undeliverable");
    expect(actions).toContain("issue.monitor_recovery_issue_created");
  });

  it("leaves clears that are not cancellations alone", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // `done`, `invalid_status`, `max_attempts_exhausted` all have their own
    // handling; this pass is only for the reason whose row may vanish.
    await seedCancelledResidue(companyId, agentId, { status: "done", clearReason: "done" });
    await seedCancelledResidue(companyId, agentId, { status: "blocked", clearReason: "invalid_status" });

    const result = await heartbeat.reconcileCancelledIssueMonitorRecoveries();
    expect(result).toMatchObject({ scanned: 0, recovered: 0, failed: 0 });
  });

  it("leaves an already-stamped row and an archived company's rows alone", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await seedCancelledResidue(companyId, agentId, { recoveryEmittedAt: "2026-11-03T02:00:00.000Z" });

    const archived = await seedCompanyAndAgent("archived");
    const archivedIssue = await seedCancelledResidue(archived.companyId, archived.agentId);

    const result = await heartbeat.reconcileCancelledIssueMonitorRecoveries();
    expect(result).toMatchObject({ scanned: 0, recovered: 0, failed: 0 });
    expect(await readRecoveryIssues(archivedIssue)).toHaveLength(0);
  });

  it("does not clobber a monitor re-armed between selection and the stamp", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledResidue(companyId, agentId, { status: "todo" });
    const rearmedAt = new Date("2026-11-05T09:00:00.000Z");

    const result = await heartbeat.reconcileCancelledIssueMonitorRecoveries({
      beforeRecover: async () => {
        // The flapping row's next arm lands mid-pass. The stamp must lose
        // rather than write `recoveryEmittedAt` onto a live monitor, which
        // would make the NEXT cancel's clear look already discharged.
        await db
          .update(issues)
          .set({
            status: "in_progress",
            monitorNextCheckAt: rearmedAt,
            executionState: {
              status: "idle",
              currentStageId: null,
              currentStageIndex: null,
              currentStageType: null,
              currentParticipant: null,
              returnAssignee: null,
              reviewRequest: null,
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
              monitor: {
                status: "scheduled",
                nextCheckAt: rearmedAt.toISOString(),
                lastTriggeredAt: null,
                attemptCount: 0,
                notes: MONITOR_NOTES,
                scheduledBy: "assignee",
                clearedAt: null,
                clearReason: null,
                recoveryEmittedAt: null,
              },
            },
          })
          .where(eq(issues.id, issueId));
      },
    });

    // The handoff still happened — the obligation was real when it was read.
    expect(result).toMatchObject({ scanned: 1, recovered: 1, failed: 0 });
    expect(await readRecoveryIssues(issueId)).toHaveLength(1);

    // But the fresh monitor is untouched, and still owes nothing.
    const row = await readIssue(issueId);
    expect(row.monitorNextCheckAt?.toISOString()).toBe(rearmedAt.toISOString());
    expect(residueOf(row.executionState)).toMatchObject({ status: "scheduled", recoveryEmittedAt: null });
  });
});
