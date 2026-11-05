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
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, issueComments, issueWorkProducts, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { logger } from "../middleware/logger.js";
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
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Two days ago, and RELATIVE on purpose.
 *
 * PEN-5346's handoff horizon is measured against a real `now`, so the fixed
 * literal this used to be would have silently flipped every case in this file
 * from "carrier emitted" to "auto-discharged" the moment the wall clock passed
 * it — a suite that rots into asserting the opposite of what it was written
 * for. Two days keeps every default-seeded clear well inside the horizon;
 * `clearedAt` is overridable per case for the ones that test the far side.
 */
const CLEARED_AT = new Date(Date.now() - 2 * DAY_MS).toISOString();
/** Comfortably past the 7-day horizon, in the band the BLO backfill occupies. */
const LONG_PAST_CLEARED_AT = new Date(Date.now() - 45 * DAY_MS).toISOString();

type MonitorResidue = {
  status?: string;
  clearReason?: string;
  clearedAt?: string | null;
  recoveryEmittedAt?: string | null;
  recoveryDisposition?: string;
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
      /** PEN-5346: moves the clear across the handoff horizon. */
      clearedAt?: string;
      /** PEN-5346: the due time the clear destroyed (PEN-5343's audit copy). */
      clearedNextCheckAt?: string | null;
      monitorNextCheckAt?: Date | null;
      /** Pins selection order: the pass reads `asc(updatedAt), asc(id)`. */
      updatedAt?: Date;
      /**
       * Makes the row match the SQL predicate but fail `parseIssueExecutionState`
       * — the one permanently-unhandable class that cannot be excluded in SQL.
       */
      malformed?: boolean;
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
          clearedAt: overrides.clearedAt ?? CLEARED_AT,
          clearReason: overrides.clearReason ?? "cancelled",
          ...(overrides.clearedNextCheckAt === undefined
            ? {}
            : { clearedNextCheckAt: overrides.clearedNextCheckAt }),
          ...(overrides.recoveryEmittedAt === undefined ? {} : { recoveryEmittedAt: overrides.recoveryEmittedAt }),
          ...(overrides.malformed ? { attemptCount: "not-a-number" } : {}),
        },
      },
      ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}),
      monitorNextCheckAt: overrides.monitorNextCheckAt ?? null,
      monitorNotes: null,
      monitorScheduledBy: "assignee",
      monitorAttemptCount: 0,
      cancelledAt: (overrides.status ?? "cancelled") === "cancelled"
        ? new Date(overrides.clearedAt ?? CLEARED_AT)
        : null,
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

  /**
   * PEN-5346: the handoff horizon.
   *
   * The carrier is not free. It is a `high`-priority row with an assignee, so
   * it becomes a full agent run that queues AHEAD of real remediation. Measured
   * on BLO 2026-11-05: 291 carriers in six hours, and of 24 closed ones sampled
   * evenly across the 221 then done, 24/24 closed as "obligation discharged"
   * carrying no live work — their gates named pods, alerts and PRs from August
   * to October that no longer exist. Meanwhile PlatformSRE held 92 queued runs,
   * 46 of them carriers, with 89 blocked rows waiting behind them.
   *
   * So past the horizon the handoff is stamped without a carrier. These cases
   * pin that, and — more importantly — pin the two things that must still get
   * one however old the clear is.
   */
  describe("handoff horizon", () => {
    it("discharges a long-past obligation without building a carrier (PEN-5346)", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = await seedCancelledResidue(companyId, agentId, {
        clearedAt: LONG_PAST_CLEARED_AT,
      });

      const result = await heartbeat.reconcileCancelledIssueMonitorRecoveries();
      expect(result).toMatchObject({ scanned: 1, recovered: 0, autoDischarged: 1, skipped: 0, failed: 0 });

      // No carrier, and so no run: that is the entire point of the horizon.
      await expect(readRecoveryIssues(issueId)).resolves.toHaveLength(0);

      // Discharged, not left owed. The post-condition is the same one the
      // carrier path holds to — exactly one well-defined state — and
      // `recoveryDisposition` is what keeps the two states distinguishable.
      const residue = residueOf((await readIssue(issueId)).executionState);
      expect(residue.recoveryEmittedAt).toBeTruthy();
      expect(residue.recoveryDisposition).toBe("auto_discharged_past_horizon");
    });

    it("re-selects nothing once discharged, so the pass does not re-emit (PEN-5346)", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      await seedCancelledResidue(companyId, agentId, { clearedAt: LONG_PAST_CLEARED_AT });

      await heartbeat.reconcileCancelledIssueMonitorRecoveries();
      const second = await heartbeat.reconcileCancelledIssueMonitorRecoveries();
      expect(second).toMatchObject({ scanned: 0, recovered: 0, autoDischarged: 0 });
    });

    it("still carries an old clear whose destroyed due time is STILL AHEAD (PEN-5346)", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      // The clear itself is ancient, but the wake it destroyed has not yet come
      // due — nobody has had the chance to meet that obligation, so age is the
      // wrong question and the carrier is owed.
      const issueId = await seedCancelledResidue(companyId, agentId, {
        clearedAt: LONG_PAST_CLEARED_AT,
        clearedNextCheckAt: new Date(Date.now() + 3 * DAY_MS).toISOString(),
      });

      const result = await heartbeat.reconcileCancelledIssueMonitorRecoveries();
      expect(result).toMatchObject({ scanned: 1, recovered: 1, autoDischarged: 0 });
      await expect(readRecoveryIssues(issueId)).resolves.toHaveLength(1);

      const residue = residueOf((await readIssue(issueId)).executionState);
      expect(residue.recoveryDisposition).toBe("recovery_issue");
    });

    it("still carries an old clear whose source solely owns an OPEN work product (PEN-5346)", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = await seedCancelledResidue(companyId, agentId, {
        clearedAt: LONG_PAST_CLEARED_AT,
      });
      // The terminal branch this row was widened for (PEN-4835): a cancelled
      // row whose remediation PR outlived it and has nothing else pointing at
      // it. A remediation PR normally OUTLIVES the alert that prompted it — it
      // is usually why the alert resolved — so this is precisely the class for
      // which the age of the clear means nothing.
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: "pull_request",
        provider: "github",
        externalId: "Blockcast/onprem-k8s#7360",
        title: "fix(prod-07): restart node-exporter under the new unit",
        status: "ready_for_review",
      });

      const result = await heartbeat.reconcileCancelledIssueMonitorRecoveries();
      expect(result).toMatchObject({ scanned: 1, recovered: 1, autoDischarged: 0 });
      await expect(readRecoveryIssues(issueId)).resolves.toHaveLength(1);
    });

    it("discharges when the only work product the source owns is already terminal (PEN-5346)", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = await seedCancelledResidue(companyId, agentId, {
        clearedAt: LONG_PAST_CLEARED_AT,
      });
      // Merged is the common case behind a genuinely-resolved alert, and it is
      // the one the BLO sample kept finding: the PR landed months ago and the
      // carrier existed only to re-discover that.
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: "pull_request",
        provider: "github",
        externalId: "Blockcast/onprem-k8s#7301",
        title: "fix(prod-07): the merge that resolved this alert",
        status: "merged",
      });

      const result = await heartbeat.reconcileCancelledIssueMonitorRecoveries();
      expect(result).toMatchObject({ scanned: 1, recovered: 0, autoDischarged: 1 });
      await expect(readRecoveryIssues(issueId)).resolves.toHaveLength(0);
    });
  });

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

  it("refuses to discharge an obligation it cannot hand to anyone (unassigned source)", async () => {
    const { companyId } = await seedCompanyAndAgent();
    // Reachable two ways: a flapping row reopened and then released, or a
    // canceller that unassigned on its way out. `issueAllowsMonitor` requires
    // an assignee, so the monitor WAS owned when it was armed.
    const issueId = await seedCancelledResidue(companyId, null);

    const result = await heartbeat.reconcileCancelledIssueMonitorRecoveries();
    expect(result).toMatchObject({ scanned: 1, recovered: 0, unowned: 1, failed: 0 });

    // No carrier: the recovery row inherits the source's assignee, so creating
    // one here would mint an ownerless `todo` that no wake can ever reach —
    // the same strand this pass exists to remove, one row further along.
    expect(await readRecoveryIssues(issueId)).toHaveLength(0);

    // And critically, the obligation is still OWED. Stamping would record it as
    // discharged by a carrier that never existed.
    const source = await readIssue(issueId);
    expect(residueOf(source.executionState).recoveryEmittedAt ?? null).toBeNull();
  });

  it("hands back for real once an unassigned source gets an owner", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledResidue(companyId, null);

    expect(await heartbeat.reconcileCancelledIssueMonitorRecoveries()).toMatchObject({ unowned: 1, recovered: 0 });
    await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, issueId));

    const second = await heartbeat.reconcileCancelledIssueMonitorRecoveries();
    expect(second).toMatchObject({ scanned: 1, recovered: 1, unowned: 0, failed: 0 });
    expect(await readRecoveryIssues(issueId)).toHaveLength(1);
    expect(residueOf((await readIssue(issueId)).executionState).recoveryEmittedAt).toBeTruthy();
  });

  it("creates exactly one carrier when two passes run concurrently", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedCancelledResidue(companyId, agentId);

    // `setInterval` starts tick N+1 whether or not tick N settled, and the
    // startup pass can overlap the first periodic one. `index.ts` single-flights
    // this pass for cost; `issues_active_stranded_issue_recovery_uq` is what
    // makes a duplicate carrier impossible even when the latch is bypassed, as
    // it is here and as it would be across two replicas.
    const [a, b] = await Promise.all([
      heartbeat.reconcileCancelledIssueMonitorRecoveries(),
      heartbeat.reconcileCancelledIssueMonitorRecoveries(),
    ]);

    expect(await readRecoveryIssues(issueId)).toHaveLength(1);
    // One obligation, one carrier, and no pass invented a second one.
    expect(a.recovered + b.recovered).toBeGreaterThanOrEqual(1);
    expect(residueOf((await readIssue(issueId)).executionState).recoveryEmittedAt).toBeTruthy();
  });

  it("does not let rows it can never discharge starve the ones it can", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // Selection is `asc(updatedAt)`, and neither of these two advances it: an
    // unowned row and a malformed one both emit nothing. Without paging they
    // would sit at the head of every page forever and the healthy row behind
    // them would never be reached — with a `warn` line as the only symptom.
    await seedCancelledResidue(companyId, null, { updatedAt: new Date("2026-11-01T00:00:00.000Z") });
    await seedCancelledResidue(companyId, agentId, {
      malformed: true,
      updatedAt: new Date("2026-11-01T00:00:01.000Z"),
    });
    const healthy = await seedCancelledResidue(companyId, agentId, {
      updatedAt: new Date("2026-11-01T00:00:02.000Z"),
    });

    // `limit: 1` makes each undischargeable row its own full page, so the pass
    // only reaches the healthy row by walking past both.
    const result = await heartbeat.reconcileCancelledIssueMonitorRecoveries({ limit: 1 });

    expect(result).toMatchObject({ recovered: 1, unowned: 1, skipped: 1, failed: 0 });
    expect(await readRecoveryIssues(healthy)).toHaveLength(1);
  });

  it("will not synthesise a wake idempotency key for a clear with no clearedAt", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // No in-tree construction site writes this, which is the point: keying the
    // wake on `now` instead would change the key every pass and stop the
    // re-offer deduping in precisely the state where nothing else does.
    const issueId = await seedCancelledResidue(companyId, agentId);
    await db
      .update(issues)
      .set({ executionState: sql`jsonb_set(${issues.executionState}::jsonb, '{monitor,clearedAt}', 'null'::jsonb)` })
      .where(eq(issues.id, issueId));

    const result = await heartbeat.reconcileCancelledIssueMonitorRecoveries();
    expect(result).toMatchObject({ scanned: 0, recovered: 0, failed: 0 });
    expect(await readRecoveryIssues(issueId)).toHaveLength(0);
    expect(residueOf((await readIssue(issueId)).executionState).recoveryEmittedAt ?? null).toBeNull();
  });

  /**
   * PEN-5346 §4. The three tests below pin the one thing the shipped pass could
   * not say: that it had selected work and discharged none of it.
   *
   * `scanned` and `skipped` are computed and returned, and then discarded at
   * both call sites in `index.ts`, whose log condition reads only
   * `recovered`/`cleared`/`unowned`/`failed`. So an inert pass was byte-identical
   * in the logs to a pass that selected nothing, which is byte-identical to the
   * healthy drained steady state. Measured in production on 2026-11-04 with
   * >= 21 rows carrying the residue: zero log lines on either worker.
   */
  type InertLine = [Record<string, unknown>, string];

  function inertLines(warn: { mock: { calls: unknown[][] } }): InertLine[] {
    return warn.mock.calls.filter(
      (call): call is InertLine => typeof call[1] === "string" && call[1].includes("discharged none of them"),
    );
  }

  it("says so when every candidate it selected was skipped (PEN-5346 §4)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // Malformed rows match the SQL predicate and fail `parseIssueExecutionState`
    // — the permanently-unhandable class, and the exact shape that produced
    // total silence in production.
    await seedCancelledResidue(companyId, agentId, { malformed: true });
    await seedCancelledResidue(companyId, agentId, { malformed: true });

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const result = await heartbeat.reconcileCancelledIssueMonitorRecoveries();
      expect(result).toMatchObject({ scanned: 2, recovered: 0, cleared: 0, skipped: 2, unowned: 0, failed: 0 });

      const lines = inertLines(warn);
      expect(lines).toHaveLength(1);
      expect(lines[0]![0]).toMatchObject({ scanned: 2, skipped: 2, recovered: 0, cleared: 0 });
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent when there was nothing to discharge (PEN-5346 §4)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // Already stamped: selects nothing. Silence here is the one reading that
    // means what an operator takes it to mean, so it must stay silent.
    await seedCancelledResidue(companyId, agentId, { recoveryEmittedAt: "2026-11-03T02:00:00.000Z" });

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const result = await heartbeat.reconcileCancelledIssueMonitorRecoveries();
      expect(result).toMatchObject({ scanned: 0, skipped: 0 });
      expect(inertLines(warn)).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("throttles an unchanged inert shape but reports a changed one immediately (PEN-5346 §4)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // FOUR rows, not two: the slot is keyed on the pass's shape and lives for
    // the life of the service, so seeding the same count as the test above
    // would make this test's first call a THROTTLED one and the assertion
    // below order-dependent. A shape no other test in this file produces makes
    // the establishing call establish something whatever ran before it.
    for (let i = 0; i < 4; i += 1) {
      await seedCancelledResidue(companyId, agentId, { malformed: true });
    }

    // Establishes the slot for this shape, whatever the previous test left.
    await heartbeat.reconcileCancelledIssueMonitorRecoveries();

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      // Same shape inside the interval: the condition persists on every 30 s
      // tick, so re-emitting it would be ~2 880 lines a day.
      await heartbeat.reconcileCancelledIssueMonitorRecoveries();
      expect(inertLines(warn)).toHaveLength(0);

      // A population that is actually draining changes shape, and that is the
      // movement an operator needs to see without waiting out the interval.
      await seedCancelledResidue(companyId, agentId, { malformed: true });
      await heartbeat.reconcileCancelledIssueMonitorRecoveries();

      const lines = inertLines(warn);
      expect(lines).toHaveLength(1);
      // Honest about how many passes the emitted line stands for.
      expect(lines[0]![0]).toMatchObject({ scanned: 5, skipped: 5, suppressedSincePreviousLog: 1 });
    } finally {
      warn.mockRestore();
    }
  });
});
