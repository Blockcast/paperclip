import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";
import { computeIssueMonitorGateFingerprint } from "../services/issue-execution-policy.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { issueService } from "../services/issues.js";
import {
  STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS,
  STRANDED_RECOVERY_OWNER_WAKE_HORIZON_MS,
  recoveryService,
  strandedRecoveryWakeAttemptsExhausted,
} from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * BLO-18996 (review follow-up): lets one test make `releaseWakeAttempt` fail.
 *
 * `recoveryService` builds its own `issueRecoveryActionService(db)` internally, so there is
 * no dependency seam to inject through. The mock below wraps the real factory and routes
 * `releaseWakeAttempt` through this hook; while the hook is null it is a pure pass-through,
 * so every other test in this file sees the unmodified service.
 */
let releaseWakeAttemptFailures: number | null = null;
vi.mock("../services/issue-recovery-actions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-recovery-actions.js")>();
  return {
    ...actual,
    issueRecoveryActionService: (...args: Parameters<typeof actual.issueRecoveryActionService>) => {
      const svc = actual.issueRecoveryActionService(...args);
      return {
        ...svc,
        releaseWakeAttempt: async (input: Parameters<typeof svc.releaseWakeAttempt>[0]) => {
          if (releaseWakeAttemptFailures !== null && releaseWakeAttemptFailures > 0) {
            releaseWakeAttemptFailures -= 1;
            throw new Error("transient refund failure");
          }
          return svc.releaseWakeAttempt(input);
        },
      };
    },
  };
});

function makeRecoveryActionRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-05-09T19:30:00.000Z");
  return {
    id: randomUUID(),
    companyId: "company-1",
    sourceIssueId: "source-1",
    recoveryIssueId: null,
    kind: "missing_disposition",
    status: "active",
    ownerType: "agent",
    ownerAgentId: "agent-1",
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "successful_run_missing_issue_disposition",
    fingerprint: "missing-disposition:fingerprint",
    evidence: {},
    nextAction: "Choose a valid issue disposition.",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: null,
    timeoutAt: null,
    lastAttemptAt: now,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("issueRecoveryActionService", () => {
  it("does not reactivate an action resolved between the active read and update", async () => {
    const existingRow = makeRecoveryActionRow({ id: "existing-action", attemptCount: 1 });
    const createdRow = makeRecoveryActionRow({ id: "new-action", attemptCount: 1 });
    const selectResults = [[existingRow], []];

    const makeSelectQuery = (rows: unknown[]) => ({
      from() {
        return this;
      },
      where() {
        return this;
      },
      orderBy() {
        return this;
      },
      limit() {
        return Promise.resolve(rows);
      },
    });

    const fakeDb = {
      select: vi.fn(() => makeSelectQuery(selectResults.shift() ?? [])),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => []),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [createdRow]),
        })),
      })),
    };

    const result = await issueRecoveryActionService(fakeDb as never).upsertSourceScoped({
      companyId: "company-1",
      sourceIssueId: "source-1",
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: "agent-1",
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      nextAction: "Choose a valid issue disposition.",
    });

    expect(result).toMatchObject({ id: "new-action", status: "active" });
    expect(fakeDb.update).toHaveBeenCalledTimes(1);
    expect(fakeDb.insert).toHaveBeenCalledTimes(1);
  });

  it("preserves a bounded wake horizon across ownerless upsert flaps", async () => {
    const originalHorizon = new Date("2026-05-09T23:30:00.000Z");
    const freshHorizon = new Date("2026-05-10T05:30:00.000Z");
    let row = makeRecoveryActionRow({
      id: "existing-action",
      maxAttempts: 5,
      timeoutAt: originalHorizon,
      attemptCount: 2,
      evidence: { latestRunId: "run-1" },
    });
    const updates: Record<string, unknown>[] = [];

    const makeSelectQuery = () => ({
      from() {
        return this;
      },
      where() {
        return this;
      },
      orderBy() {
        return this;
      },
      limit() {
        return Promise.resolve(row ? [row] : []);
      },
    });

    const fakeDb = {
      select: vi.fn(() => makeSelectQuery()),
      update: vi.fn(() => ({
        set: vi.fn((patch: Record<string, unknown>) => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              updates.push(patch);
              row = { ...row, ...patch };
              return [row];
            }),
          })),
        })),
      })),
      insert: vi.fn(),
    };
    const svc = issueRecoveryActionService(fakeDb as never);

    const ownerless = await svc.upsertSourceScoped({
      companyId: "company-1",
      sourceIssueId: "source-1",
      kind: "stranded_assigned_issue",
      ownerType: "board",
      ownerAgentId: null,
      cause: "stranded_assigned_issue",
      fingerprint: "source-scoped:fingerprint:ownerless",
      evidence: { latestRunId: "run-2" },
      nextAction: "Wait for a recovery owner.",
      maxAttempts: null,
      timeoutAt: null,
    });

    expect(ownerless).toMatchObject({ ownerAgentId: null, maxAttempts: null });
    expect(new Date(ownerless.timeoutAt as unknown as string).getTime()).toBe(originalHorizon.getTime());
    expect(ownerless.evidence).toMatchObject({
      latestRunId: "run-2",
      sourceScopedWakeHorizonAt: originalHorizon.toISOString(),
    });

    const rebound = await svc.upsertSourceScoped({
      companyId: "company-1",
      sourceIssueId: "source-1",
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: "agent-1",
      cause: "stranded_assigned_issue",
      fingerprint: "source-scoped:fingerprint:bounded",
      evidence: { latestRunId: "run-3" },
      nextAction: "Wake the recovery owner.",
      maxAttempts: 5,
      timeoutAt: freshHorizon,
    });

    expect(rebound).toMatchObject({ ownerAgentId: "agent-1", maxAttempts: 5 });
    expect(new Date(rebound.timeoutAt as unknown as string).getTime()).toBe(originalHorizon.getTime());
    expect(rebound.evidence).toMatchObject({
      latestRunId: "run-3",
      sourceScopedWakeHorizonAt: originalHorizon.toISOString(),
    });
    expect(updates.at(-1)).toMatchObject({ timeoutAt: originalHorizon });
  });

  // BLO-20263. The handoff comment grant's TTL is measured from this anchor, so if
  // ordinary sweep churn refreshed it the grant would never expire — which is the
  // failure mode the ticket exists to close, not a cosmetic detail.
  it("re-anchors the handoff grant on a real transfer but not on sweep churn", async () => {
    const staleAnchor = new Date("2026-05-01T00:00:00.000Z");
    let row = makeRecoveryActionRow({
      id: "existing-action",
      previousOwnerAgentId: "agent-previous",
      ownerAgentId: "agent-owner",
      evidence: { latestRunId: "run-1", recoveryHandoffGrantAnchorAt: staleAnchor.toISOString() },
    });
    const updates: Record<string, unknown>[] = [];
    const makeSelectQuery = () => ({
      from() {
        return this;
      },
      where() {
        return this;
      },
      orderBy() {
        return this;
      },
      limit() {
        return Promise.resolve(row ? [row] : []);
      },
    });
    const fakeDb = {
      select: vi.fn(() => makeSelectQuery()),
      update: vi.fn(() => ({
        set: vi.fn((patch: Record<string, unknown>) => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              updates.push(patch);
              row = { ...row, ...patch };
              return [row];
            }),
          })),
        })),
      })),
      insert: vi.fn(),
    };
    const svc = issueRecoveryActionService(fakeDb as never);
    const sweep = (previousOwnerAgentId: string | null) => svc.upsertSourceScoped({
      companyId: "company-1",
      sourceIssueId: "source-1",
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: "agent-owner",
      previousOwnerAgentId,
      cause: "stranded_assigned_issue",
      fingerprint: `source-scoped:fingerprint:${randomUUID()}`,
      evidence: { latestRunId: "run-2" },
      nextAction: "Hand the diagnosis to the recovery owner.",
    });

    // A re-sweep naming the SAME previous owner is not a new transfer. The anchor
    // must survive it even though `evidence` is otherwise replaced wholesale and
    // `lastAttemptAt` is pushed forward on this very write.
    const resweep = await sweep("agent-previous");
    expect(resweep.evidence).toMatchObject({
      latestRunId: "run-2",
      recoveryHandoffGrantAnchorAt: staleAnchor.toISOString(),
    });
    expect(updates.at(-1)?.lastAttemptAt).toBeInstanceOf(Date);

    // An omitted previous owner carries the existing one forward, so it is also
    // not a transfer and must not re-anchor.
    const carried = await sweep(null);
    expect(carried.evidence).toMatchObject({
      recoveryHandoffGrantAnchorAt: staleAnchor.toISOString(),
    });

    // A production recovery re-sweep sees the issue assigned to the recovery owner
    // from the previous pass. That input must not make the owner the new grant
    // subject or refresh the TTL anchor.
    const recoveryOwnerChurn = await sweep("agent-owner");
    expect(recoveryOwnerChurn).toMatchObject({ previousOwnerAgentId: "agent-previous" });
    expect(recoveryOwnerChurn.evidence).toMatchObject({
      recoveryHandoffGrantAnchorAt: staleAnchor.toISOString(),
    });

    // Handing the issue away from a DIFFERENT agent is a real transfer: that agent
    // is owed a fresh channel, so the anchor moves to now.
    const transferred = await sweep("agent-second-previous");
    const anchor = (transferred.evidence as Record<string, unknown>).recoveryHandoffGrantAnchorAt;
    expect(typeof anchor).toBe("string");
    expect(new Date(anchor as string).getTime()).toBeGreaterThan(staleAnchor.getTime());
    expect(transferred).toMatchObject({ previousOwnerAgentId: "agent-second-previous" });
  });
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue recovery action tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue recovery actions", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-recovery-actions-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(environments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `RA${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Implement backend recovery",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    return { companyId, managerId, coderId, sourceIssueId, prefix, sourceIssue: sourceIssue! };
  }

  async function seedHeartbeatRun(input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId?: string;
    status?: string;
  }) {
    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "manual",
      status: input.status ?? "running",
      startedAt: new Date("2026-05-13T18:00:00.000Z"),
      contextSnapshot: input.issueId ? { issueId: input.issueId } : undefined,
    });
  }

  function createApp(
    actor: any = { type: "board", source: "local_implicit" },
    opts: Parameters<typeof issueRoutes>[2] = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, opts));
    app.use(errorHandler);
    return app;
  }

  it("upserts one active source-scoped action per issue and keeps company scoping explicit", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);

    const first = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });
    const second = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-2" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });

    expect(second.id).toBe(first.id);
    expect(second.attemptCount).toBe(2);
    expect(second.evidence).toMatchObject({ latestRunId: "run-2" });
    expect(await svc.getActiveForIssue(companyId, sourceIssueId)).toMatchObject({ id: first.id });
    expect(await svc.getActiveForIssue(randomUUID(), sourceIssueId)).toBeNull();
  });

  it.each([
    ["job_missing", "in_progress"],
    ["job_missing", "todo"],
    ["job_missing", "in_review"],
    ["k8s_pod_schedule_failed", "in_progress"],
    ["k8s_pod_schedule_failed", "todo"],
    ["k8s_pod_schedule_failed", "in_review"],
  ] as const)("does not enqueue recovery work after %s leaves an issue %s", async (errorCode, status) => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    let stageId: string | null = null;
    if (status === "in_review") {
      stageId = randomUUID();
      await db.update(issues).set({
        status,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [{
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: coderId, userId: null }],
          }],
        },
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: coderId, userId: null },
          returnAssignee: { type: "agent", agentId: coderId, userId: null },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      }).where(eq(issues.id, sourceIssueId));
    } else if (status === "todo") {
      await db.update(issues).set({ status }).where(eq(issues.id, sourceIssueId));
    }
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "failed",
      error: "External lifecycle Job is missing while heartbeat run is still running",
      errorCode,
      resultJson: {
        externalLifecycleRecovery: { adapterInvocationStarted: true },
      },
      contextSnapshot: {
        issueId: sourceIssueId,
        ...(stageId ? { executionStage: { stageId, stageType: "review" } } : {}),
      },
      startedAt: new Date("2026-07-26T13:45:00.000Z"),
      finishedAt: new Date("2026-07-26T13:52:00.000Z"),
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({
      continuationRequeued: 0,
      dispatchRequeued: 0,
      reviewParticipantRequeued: 0,
      escalated: 1,
    });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup.mock.calls[0]?.[1]).toMatchObject({
      reason: "source_scoped_recovery_action",
      contextSnapshot: {
        allowDeliverableWork: false,
        recoveryIntent: "status_only",
      },
    });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({ status: "blocked" });
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, sourceIssueId));
    expect(comments.some(({ body }) => body.includes("non-retryable failure"))).toBe(true);
  });

  it("escalates stranded assigned work into a source action instead of a recovery issue", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    // A DELIVERED wake returns the queued run. Null models one of `enqueueWakeup`'s
    // non-delivery paths, which is refunded and spends no budget (BLO-18996 follow-up).
    const enqueueWakeup = vi.fn<
      (agentId: string, opts?: { payload?: unknown }) => Promise<{ id: string }>
    >(async () => ({ id: randomUUID() }));
    const recovery = recoveryService(db, { enqueueWakeup });
    const latestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
      resultJson: null,
      usageJson: null,
      createdAt: new Date(),
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun,
      comment: "Automatic continuation recovery failed.",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      // BLO-20263: the CODER, not the manager — see the longer note on the
      // latest-run-IDs test above. Both sweeps replay the coder's own failed run, so
      // the second sweep is recovery observing its own reassignment and must leave the
      // grant subject alone. `managerId` here asserted the pre-fix behaviour.
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: managerId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(updatedIssue).toMatchObject({
      status: "blocked",
    });
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
    expect(enqueueWakeup.mock.calls[0]?.[1]?.payload).toMatchObject({
      issueId: sourceIssue.id,
      sourceIssueId: sourceIssue.id,
      recoveryCause: "stranded_assigned_issue",
    });
  });

  // BLO-19954: paired with the test above. A routine-execution issue whose
  // only run was cancelled because another open routine-execution issue
  // already owns the dispatch lock is benign, intentional control flow under
  // `always_enqueue` + a single-owner dispatcher -- not a strand. It must
  // reach a terminal `cancelled` status directly, with zero recovery actions
  // and no owner wake, unlike the `adapter_failed` case above which still
  // escalates to `blocked` with one recovery action and one wake.
  it("cancels a duplicate-suppressed routine-execution run instead of creating a recovery action", async () => {
    const { sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn<
      (agentId: string, opts?: { payload?: unknown }) => Promise<{ id: string }>
    >(async () => ({ id: randomUUID() }));
    const recovery = recoveryService(db, { enqueueWakeup });
    const latestRun = {
      id: randomUUID(),
      agentId: sourceIssue.assigneeAgentId,
      status: "cancelled",
      error:
        "Cancelled because another open routine execution issue already owns this dispatch lock; " +
        "the owner run will continue the work",
      errorCode: "routine_execution_duplicate_suppressed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: null,
      resultJson: null,
      usageJson: null,
      createdAt: new Date(),
    } as const;

    const updated = await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun,
      comment: "Automatic continuation recovery failed.",
    });
    expect(updated).toMatchObject({ status: "cancelled" });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const [finalIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(finalIssue).toMatchObject({ status: "cancelled", assigneeAgentId: sourceIssue.assigneeAgentId });
  });

  it.each([
    ["process_lost", undefined, "coder"],
    ["adapter_failed", "successful_run_missing_state", "coder"],
    ["codex_output_inactivity_monitor", undefined, "coder"],
    ["workspace_validation_failed", "workspace_validation_failed", "manager"],
    ["adapter_failed", undefined, "manager"],
  ] as const)(
    "routes %s recovery through the cause-keyed playbook",
    async (errorCode, explicitCause, expectedOwner) => {
      const { managerId, coderId, sourceIssue } = await seedCompany();
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      const latestRun = {
        id: randomUUID(),
        agentId: coderId,
        status: errorCode === "adapter_failed" && explicitCause === "successful_run_missing_state"
          ? "succeeded"
          : "failed",
        error: `${errorCode} failure`,
        errorCode,
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
        resultJson: errorCode === "workspace_validation_failed"
          ? { workspaceValidation: { reason: "missing_workspace", fingerprint: "workspace:test" } }
          : null,
      } as const;

      await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        ...(explicitCause ? { recoveryCause: explicitCause } : {}),
      });

      const expectedOwnerId = expectedOwner === "coder" ? coderId : managerId;
      const [action] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
      expect(action?.ownerAgentId).toBe(expectedOwnerId);
      if (errorCode === "workspace_validation_failed") {
        expect(action?.wakePolicy).toMatchObject({
          type: "manual_repair_required",
          reason: "workspace_validation_failed",
          ownerAgentId: expectedOwnerId,
        });
        expect(enqueueWakeup).not.toHaveBeenCalled();
        return;
      }
      expect(enqueueWakeup).toHaveBeenCalledWith(
        expectedOwnerId,
        expect.objectContaining({
          reason: "source_scoped_recovery_action",
          payload: expect.objectContaining({
            recoveryCause: explicitCause ?? (errorCode === "adapter_failed" ? "stranded_assigned_issue" : errorCode),
          }),
        }),
      );
    },
  );

  it("schedules a provider-quota monitor for the original assignee without creating recovery work", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      error: "You've hit your usage limit for GPT-5. Try again at 12:00 AM (UTC).",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
      monitorScheduledBy: "assignee",
      monitorNotes: "Provider usage quota reached; retry the original assignee at the provider reset time.",
    });
    expect(updatedIssue?.monitorNextCheckAt).toBeInstanceOf(Date);
    expect(updatedIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: runId,
        maxAttempts: null,
        recoveryPolicy: "wake_owner",
      },
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun).toMatchObject({ errorCode: "provider_quota" });
    expect(updatedRun?.resultJson).toMatchObject({ errorFamily: "provider_quota" });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const secondResult = await recovery.reconcileStrandedAssignedIssues();
    expect(secondResult).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
  });

  it("schedules another provider-quota monitor after a prior quota monitor fired", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const previousQuotaNotes = "Provider usage quota reached; retry the original assignee after the default recovery backoff.";
    const { fingerprint, source } = computeIssueMonitorGateFingerprint({ notes: previousQuotaNotes });
    await db.update(issues).set({
      monitorAttemptCount: 1,
      monitorLastTriggeredAt: new Date("2026-07-15T20:30:00.000Z"),
      monitorNotes: previousQuotaNotes,
      monitorScheduledBy: "assignee",
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
          status: "triggered",
          nextCheckAt: null,
          lastTriggeredAt: "2026-07-15T20:30:00.000Z",
          attemptCount: 1,
          notes: previousQuotaNotes,
          scheduledBy: "assignee",
          kind: "external_service",
          serviceName: "AI provider quota",
          externalRef: "previous-run",
          timeoutAt: null,
          maxAttempts: null,
          recoveryPolicy: "wake_owner",
          gateSignals: null,
          gateFingerprint: fingerprint,
          gateSource: source,
          convergenceCount: 3,
          clearedAt: null,
          clearReason: null,
        },
      },
    }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T21:00:00.000Z"),
      finishedAt: new Date("2026-07-15T21:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue?.status).toBe("in_progress");
    expect(updatedIssue?.monitorNextCheckAt).toBeInstanceOf(Date);
    expect(updatedIssue?.executionPolicy).toMatchObject({
      monitor: {
        maxAttempts: null,
        externalRef: runId,
      },
    });
  });

  it("skips provider-quota monitor scheduling for todo issues without aborting reconciliation", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not create takeover recovery when a quota monitor cannot be scheduled", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("schedules a quota monitor for a cross-agent active review participant", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const [reviewIssueBeforeRecovery] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(reviewIssueBeforeRecovery).toMatchObject({
      assigneeAgentId: coderId,
      executionState: {
        currentParticipant: { type: "agent", agentId: managerId },
        returnAssignee: { type: "agent", agentId: coderId },
      },
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId, executionStage: { stageId, stageType: "review" } },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 1, reviewParticipantRequeued: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: expect.any(Date),
      monitorNotes: "Provider usage quota reached; retry the active review participant after the default recovery backoff.",
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("provider_quota");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not restamp an in_review quota monitor when the assignee has a newer terminal run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const participantRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: participantRunId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId, executionStage: { stageId, stageType: "review" } },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const firstResult = await recovery.reconcileStrandedAssignedIssues();

    expect(firstResult).toMatchObject({ providerQuotaMonitored: 1 });
    const [monitoredIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    const firstNextCheckAt = monitoredIssue?.monitorNextCheckAt;
    expect(firstNextCheckAt).toBeInstanceOf(Date);
    expect(monitoredIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: participantRunId,
      },
    });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "failed",
      error: "Stale assignee wake fired after the issue entered review.",
      errorCode: "issue_assignee_changed",
      startedAt: new Date("2026-07-15T20:02:00.000Z"),
      finishedAt: new Date("2026-07-15T20:03:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });

    const secondResult = await recovery.reconcileStrandedAssignedIssues();

    expect(secondResult).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [unchangedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(unchangedIssue?.monitorNextCheckAt?.getTime()).toBe(firstNextCheckAt?.getTime());
    expect(unchangedIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: participantRunId,
      },
    });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("classifies review recovery from the active participant run instead of a newer assignee run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const participantRunId = randomUUID();
    const assigneeRunId = randomUUID();
    await db.insert(heartbeatRuns).values([{
      id: participantRunId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      error: "review process exited unexpectedly",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId, executionStage: { stageId, stageType: "review" } },
    }, {
      id: assigneeRunId,
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "failed",
      error: "You've hit your usage limit. Try again at 11:00 PM (UTC)",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:02:00.000Z"),
      finishedAt: new Date("2026-07-15T20:03:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    }]);
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, reviewParticipantRequeued: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [assigneeRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, assigneeRunId));
    expect(assigneeRun?.errorCode).toBe("adapter_failed");
    expect(enqueueWakeup).toHaveBeenCalledWith(managerId, expect.objectContaining({
      reason: "execution_review_participant_recovery",
      payload: expect.objectContaining({ issueId: sourceIssueId, retryOfRunId: participantRunId }),
    }));
  });

  it("blocks a cross-agent review participant with incomplete configuration", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      error: "model_not_found: requested review model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId, executionStage: { stageId, stageType: "review" } },
    });
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 1, reviewParticipantRequeued: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "blocked",
      assigneeAgentId: managerId,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("configuration_incomplete");
    const [action] = await db.select().from(issueRecoveryActions);
    expect(action).toMatchObject({
      sourceIssueId,
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      cause: "configuration_incomplete",
      recoveryIssueId: null,
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("uses the default quota backoff when the provider does not state a reset time", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
      monitorNotes: "Provider usage quota reached; retry the original assignee after the default recovery backoff.",
    });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
  });

  it("classifies model lookup failures as configuration incomplete without waking a recovery owner", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      error: "model_not_found: requested model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 1, skipped: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue?.status).toBe("blocked");
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("configuration_incomplete");
    const [action] = await db.select().from(issueRecoveryActions);
    expect(action).toMatchObject({
      sourceIssueId,
      cause: "configuration_incomplete",
      recoveryIssueId: null,
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not classify stale configuration failures from a non-assignee run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "manual",
      status: "failed",
      error: "model_not_found: previous assignee model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("reuses the same source-scoped action when latest run IDs change while the cause stays the same", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    // A DELIVERED wake returns the queued run. Null models one of `enqueueWakeup`'s
    // non-delivery paths, which is refunded and spends no budget (BLO-18996 follow-up).
    const enqueueWakeup = vi.fn<
      (agentId: string, opts?: { payload?: unknown }) => Promise<{ id: string }>
    >(async () => ({ id: randomUUID() }));
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
      resultJson: null,
      usageJson: null,
      createdAt: new Date(),
    } as const;
    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      // BLO-20263: the CODER, not the manager. Both sweeps replay a failure of the
      // coder's own run (`agentId: coderId` on both), and the second sweep only sees
      // recovery's own reassignment of the issue to the manager. The manager never ran
      // and never failed, so it is not a handoff subject and must not displace the
      // coder — the agent that actually lost `allow_self`. This expectation previously
      // read `managerId`, which encoded the sliding-anchor bug fixed on this branch.
      // Note the run IDs differ across the two sweeps here: the discriminator is whose
      // run failed, not which run, so a new run ID alone must not refresh the subject.
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: managerId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    expect(actionRows[0]?.evidence).toMatchObject({ latestRunId: secondLatestRun.id });
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
    expect(enqueueWakeup.mock.calls[1]?.[1]?.payload).toMatchObject({
      issueId: sourceIssue.id,
      sourceIssueId: sourceIssue.id,
      strandedRunId: secondLatestRun.id,
      recoveryCause: "stranded_assigned_issue",
    });
  });

  // BLO-18996: an owner who cannot discharge the action it was woken for (the reported
  // case: `issue:comment` 403'd it) leaves the action `active` forever, and every sweep
  // paid for another wake that could not possibly make progress. The wake budget turns
  // that silent infinite loop into a visible terminal state.
  it("stops waking the recovery owner once the wake budget is spent and says so on the source issue", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    // A DELIVERED wake returns the queued run. Null models one of `enqueueWakeup`'s
    // non-delivery paths, which is refunded and spends no budget (BLO-18996 follow-up).
    const enqueueWakeup = vi.fn<
      (agentId: string, opts?: { payload?: unknown }) => Promise<{ id: string }>
    >(async () => ({ id: randomUUID() }));
    const recovery = recoveryService(db, { enqueueWakeup });
    const baseRun = {
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
      resultJson: null,
      usageJson: null,
      createdAt: new Date(),
    } as const;

    // A literal, deliberately NOT derived from the exported budget: the assertion that
    // matters is that N escalations produce fewer than N wakes. On master there is no
    // budget at all, so all N fire and that comparison is what fails.
    const ESCALATIONS = 7;
    expect(STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS).toBeLessThan(ESCALATIONS);
    for (let attempt = 0; attempt < ESCALATIONS; attempt += 1) {
      await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun: { ...baseRun, id: randomUUID() },
        comment: "Automatic continuation recovery failed.",
      });
    }

    // The unbounded-loop assertion: the sweep stopped paying for wakes that cannot make
    // progress, well before it ran out of escalations to perform.
    expect(enqueueWakeup.mock.calls.length).toBeLessThan(ESCALATIONS);
    expect(enqueueWakeup.mock.calls.length).toBe(STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRow).toMatchObject({
      status: "active",
      attemptCount: ESCALATIONS,
      maxAttempts: STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS,
    });

    const commentBodies = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, sourceIssue.id))
      .then((rows) => rows.map((row) => row.body ?? ""));
    const exhaustionComments = commentBodies.filter((body) =>
      body.includes(`Recovery wake budget exhausted for action \`${actionRow!.id}\``),
    );
    expect(exhaustionComments).toHaveLength(1);

    // Idempotent: a further sweep neither wakes anyone nor repeats the announcement.
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: { ...baseRun, id: randomUUID() },
      comment: "Automatic continuation recovery failed.",
    });
    expect(enqueueWakeup.mock.calls.length).toBe(STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS);
    const repeatedAnnouncements = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, sourceIssue.id))
      .then((rows) =>
        rows.filter((row) =>
          (row.body ?? "").includes(`Recovery wake budget exhausted for action \`${actionRow!.id}\``)
        )
      );
    expect(repeatedAnnouncements).toHaveLength(1);
  });

  it("restores the wake budget for a replacement recovery owner and keeps the old owner's spent budget", async () => {
    // Ally's review of PR #837: the exhaustion test above calls the escalation helper
    // against one unchanging owner, so it cannot see what `upsertSourceScoped` does to
    // `attemptCount` when the OWNER changes on the active row. This drives the same
    // production path through a real post-exhaustion reassignment, which is the shape
    // that actually deadlocks: owner A burns the budget, the issue is handed to owner B,
    // and B must still be reachable. Before the fix B inherited A's spent counter and was
    // never woken, so the action stayed active and undischargeable forever.
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    // A second reporting line. `resolveStrandedIssueRecoveryOwnerAgentId` prefers the
    // assignee's `reportsTo`, so reassigning the source issue down this line is what
    // routes recovery ownership to a genuinely different owner.
    const secondManagerId = randomUUID();
    const secondCoderId = randomUUID();
    await db.insert(agents).values([
      {
        id: secondManagerId,
        companyId,
        name: "Second Manager",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: secondCoderId,
        companyId,
        name: "Second Coder",
        role: "engineer",
        status: "idle",
        reportsTo: secondManagerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    // A DELIVERED wake returns the queued run. Null models one of `enqueueWakeup`'s
    // non-delivery paths, which is refunded and spends no budget (BLO-18996 follow-up).
    const enqueueWakeup = vi.fn<
      (agentId: string, opts?: { payload?: unknown }) => Promise<{ id: string }>
    >(async () => ({ id: randomUUID() }));
    const recovery = recoveryService(db, { enqueueWakeup });
    const baseRun = {
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
      resultJson: null,
      usageJson: null,
      createdAt: new Date(),
    } as const;

    // Count wakes addressed to a specific owner. Total call count is the wrong measure:
    // `enqueueSourceScopedStrandedRecoveryWake` also has an assignee-fallback branch that
    // wakes the assignee instead of the owner, and those calls are not owner wakes.
    const wakesTo = (agentId: string) =>
      enqueueWakeup.mock.calls.filter((call) => call[0] === agentId).length;

    // 1. Spend the whole budget against the first owner.
    const ESCALATIONS = STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS + 2;
    for (let attempt = 0; attempt < ESCALATIONS; attempt += 1) {
      await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun: { ...baseRun, id: randomUUID() },
        comment: "Automatic continuation recovery failed.",
      });
    }
    expect(wakesTo(managerId)).toBe(STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS);
    const [exhaustedAction] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(exhaustedAction).toMatchObject({ status: "active", ownerAgentId: managerId });
    expect(exhaustedAction!.attemptCount).toBeGreaterThan(STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS);

    // 2. Hand the work to the other reporting line, then sweep again through the real path.
    await db
      .update(issues)
      .set({ assigneeAgentId: secondCoderId, status: "in_progress" })
      .where(eq(issues.id, sourceIssue.id));
    const [reassignedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    await recovery.escalateStrandedAssignedIssue({
      issue: reassignedIssue!,
      previousStatus: "in_progress",
      latestRun: { ...baseRun, id: randomUUID() },
      comment: "Automatic continuation recovery failed.",
    });

    // 3. The replacement owner is reachable again: the counter restarted, and the wake
    //    actually went to the new owner rather than being swallowed by the spent budget.
    //    This is the assertion that fails before the fix — B inherited A's spent counter,
    //    so `strandedRecoveryWakeAttemptsExhausted` short-circuited and B got nothing.
    const [reassignedAction] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(reassignedAction).toMatchObject({
      status: "active",
      ownerAgentId: secondManagerId,
      attemptCount: 1,
    });
    expect(wakesTo(secondManagerId)).toBe(1);

    // 4. The restored budget is still a budget: the new owner is bounded exactly as the
    //    first one was, so this cannot become a way to wake someone forever by churning
    //    the assignee. (The fingerprint ends in the assignee and changes on every sweep,
    //    which is why the reset keys on the owner instead.)
    //    Escalation reassigns the source issue to the recovery owner, and ownership routes
    //    through the assignee's `reportsTo` — so the assignee is put back on the second
    //    reporting line before each sweep. Without that the routing walks up to the CTO and
    //    this would measure owner churn rather than the wake budget.
    for (let attempt = 0; attempt < ESCALATIONS; attempt += 1) {
      await db
        .update(issues)
        .set({ assigneeAgentId: secondCoderId, status: "in_progress" })
        .where(eq(issues.id, sourceIssue.id));
      await recovery.escalateStrandedAssignedIssue({
        issue: reassignedIssue!,
        previousStatus: "in_progress",
        latestRun: { ...baseRun, id: randomUUID() },
        comment: "Automatic continuation recovery failed.",
      });
    }
    expect(wakesTo(secondManagerId)).toBe(STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS);
    // The first owner's budget stayed spent — the reset is scoped to the new owner.
    expect(wakesTo(managerId)).toBe(STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS);

    // 5. And the new owner's exhaustion is announced on its own terms, rather than being
    //    deduped away by the first owner's notice on the same reused action row.
    const exhaustionComments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, sourceIssue.id))
      .then((rows) =>
        rows.filter((row) =>
          (row.body ?? "").includes(`Recovery wake budget exhausted for action \`${exhaustedAction!.id}\``)
        ).map((row) => row.body ?? "")
      );
    expect(exhaustionComments).toHaveLength(2);
    expect(exhaustionComments.some((body) => body.includes(`(owner \`${managerId}\`)`))).toBe(true);
    expect(exhaustionComments.some((body) => body.includes(`(owner \`${secondManagerId}\`)`))).toBe(true);
  });

  it("does not refresh the handoff grant when recovery sweeps through its own owner churn", async () => {
    const companyId = randomUUID();
    const ceoId = randomUUID();
    const ctoId = randomUUID();
    const emId = randomUUID();
    const engId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `HC${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Handoff Churn Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    const agentBase = {
      companyId,
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    } as const;
    await db.insert(agents).values([
      { ...agentBase, id: ceoId, name: "CEO", role: "ceo" },
      { ...agentBase, id: ctoId, name: "CTO", role: "cto", reportsTo: ceoId },
      { ...agentBase, id: emId, name: "EM", role: "engineer", reportsTo: ctoId },
      { ...agentBase, id: engId, name: "Eng", role: "engineer", reportsTo: emId },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Recovery owner churn should not refresh handoff grant",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: engId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });

    const enqueueWakeup = vi.fn<
      (agentId: string, opts?: { payload?: unknown }) => Promise<{ id: string }>
    >(async () => ({ id: randomUUID() }));
    const recovery = recoveryService(db, { enqueueWakeup });
    const sweep = async () => {
      const [fresh] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      await recovery.escalateStrandedAssignedIssue({
        issue: fresh!,
        previousStatus: "in_progress",
        latestRun: {
          id: randomUUID(),
          agentId: engId,
          status: "failed",
          error: "adapter failed",
          errorCode: "adapter_failed",
          contextSnapshot: { retryReason: "issue_continuation_needed" },
          livenessState: "needs_followup",
          resultJson: null,
          usageJson: null,
          createdAt: new Date(),
        },
        comment: "Automatic continuation recovery failed.",
      });
    };
    const handoffAnchor = (evidence: unknown) => {
      expect(evidence && typeof evidence === "object" && !Array.isArray(evidence)).toBe(true);
      return (evidence as Record<string, unknown>).recoveryHandoffGrantAnchorAt;
    };

    const firstSweepAt = new Date("2026-08-02T01:00:00.000Z");
    const secondSweepAt = new Date("2026-08-02T05:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(firstSweepAt);
      await sweep();
      const [firstAction] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
      expect(firstAction).toMatchObject({
        previousOwnerAgentId: engId,
        ownerAgentId: emId,
        returnOwnerAgentId: engId,
      });
      const firstAnchor = handoffAnchor(firstAction!.evidence);
      expect(firstAnchor).toBe(firstSweepAt.toISOString());

      vi.setSystemTime(secondSweepAt);
      await sweep();
      const [secondAction] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
      expect(secondAction).toMatchObject({
        previousOwnerAgentId: engId,
        ownerAgentId: ctoId,
        returnOwnerAgentId: emId,
      });
      expect(handoffAnchor(secondAction!.evidence)).toBe(firstAnchor);
    } finally {
      vi.useRealTimers();
    }

    expect(enqueueWakeup.mock.calls.map((call) => call[0])).toEqual([emId, ctoId]);
    const [sourceIssue] = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.assigneeAgentId).toBe(ctoId);
  });

  it("refreshes the handoff grant onto a recovery owner that fails on its own run", async () => {
    // The companion to the churn test above, and the case owner identity alone cannot
    // see. Both sweeps here pass `previousOwnerAgentId === existing.ownerAgentId`; the
    // churn test's second sweep replays ENG's failure, this one has EM genuinely fail
    // on its own run after taking over. Suppressing the refresh here would leave ENG as
    // the grant subject on ENG's stale anchor while EM — the agent that just lost
    // `allow_self` holding the freshest diagnosis — is routed away with no comment
    // channel at all, which is the exact deprivation #827 exists to prevent.
    const companyId = randomUUID();
    const ceoId = randomUUID();
    const ctoId = randomUUID();
    const emId = randomUUID();
    const engId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `HT${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Handoff Takeover Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    const agentBase = {
      companyId,
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    } as const;
    await db.insert(agents).values([
      { ...agentBase, id: ceoId, name: "CEO", role: "ceo" },
      { ...agentBase, id: ctoId, name: "CTO", role: "cto", reportsTo: ceoId },
      { ...agentBase, id: emId, name: "EM", role: "engineer", reportsTo: ctoId },
      { ...agentBase, id: engId, name: "Eng", role: "engineer", reportsTo: emId },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Recovery owner failing on its own run earns the handoff grant",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: engId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });

    const enqueueWakeup = vi.fn<
      (agentId: string, opts?: { payload?: unknown }) => Promise<{ id: string }>
    >(async () => ({ id: randomUUID() }));
    const recovery = recoveryService(db, { enqueueWakeup });
    // `runAgentId` is the whole point of this test: it is the only input that differs
    // between replay churn and a newly failed recovery owner.
    const sweep = async (runAgentId: string) => {
      const [fresh] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      await recovery.escalateStrandedAssignedIssue({
        issue: fresh!,
        previousStatus: "in_progress",
        latestRun: {
          id: randomUUID(),
          agentId: runAgentId,
          status: "failed",
          error: "adapter failed",
          errorCode: "adapter_failed",
          contextSnapshot: { retryReason: "issue_continuation_needed" },
          livenessState: "needs_followup",
          resultJson: null,
          usageJson: null,
          createdAt: new Date(),
        },
        comment: "Automatic continuation recovery failed.",
      });
    };
    const handoffAnchor = (evidence: unknown) => {
      expect(evidence && typeof evidence === "object" && !Array.isArray(evidence)).toBe(true);
      return (evidence as Record<string, unknown>).recoveryHandoffGrantAnchorAt;
    };
    const readAction = async () => {
      const [row] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
      return row!;
    };

    const firstSweepAt = new Date("2026-08-02T01:00:00.000Z");
    const secondSweepAt = new Date("2026-08-02T05:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // A (ENG) fails; recovery hands the issue to B (EM) and reassigns it to B.
      vi.setSystemTime(firstSweepAt);
      await sweep(engId);
      const firstAction = await readAction();
      expect(firstAction).toMatchObject({
        previousOwnerAgentId: engId,
        ownerAgentId: emId,
      });
      expect(handoffAnchor(firstAction.evidence)).toBe(firstSweepAt.toISOString());
      const [afterFirst] = await db
        .select({ assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(eq(issues.id, sourceIssueId));
      expect(afterFirst?.assigneeAgentId).toBe(emId);

      // B now fails on ITS OWN distinct run. The sweep still passes
      // `previousOwnerAgentId = EM` (the current assignee) and `existing.ownerAgentId`
      // is still EM — byte-identical to the churn case on owner identity alone.
      vi.setSystemTime(secondSweepAt);
      await sweep(emId);
      const secondAction = await readAction();
      expect(secondAction.evidence).toMatchObject({ latestRunAgentId: emId });
      // B becomes the grant subject, on a fresh anchor, while ownership routes to C.
      expect(secondAction).toMatchObject({
        previousOwnerAgentId: emId,
        ownerAgentId: ctoId,
      });
      expect(handoffAnchor(secondAction.evidence)).toBe(secondSweepAt.toISOString());
    } finally {
      vi.useRealTimers();
    }

    expect(enqueueWakeup.mock.calls.map((call) => call[0])).toEqual([emId, ctoId]);
  });

  it("bounds the wakes even when recovery ownership ping-pongs and never spends one owner's budget", async () => {
    // The per-owner attempt budget is not a bound on its own. Escalation reassigns the
    // source issue to the recovery owner, and `resolveStrandedIssueRecoveryOwnerAgentId`
    // routes from the new assignee's `reportsTo` — so in an org deeper than two levels
    // ownership ping-pongs (CTO -> CEO -> CTO -> ...): the CEO has no `reportsTo`, so the
    // role fallback picks the CTO again. Every sweep is then an owner change, `attemptCount`
    // never leaves 1, and `maxAttempts` is never reached. Measured on the owner-keyed reset
    // before the horizon existed: 30 wakes over 30 sweeps against a budget of 5.
    //
    // `timeoutAt` is the bound that holds here, because it is anchored to the action's
    // creation and `upsertSourceScoped` preserves it instead of re-deriving it per sweep.
    const companyId = randomUUID();
    const ceoId = randomUUID();
    const ctoId = randomUUID();
    const emId = randomUUID();
    const engId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `PP${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Pingpong Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    const agentBase = {
      companyId,
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    } as const;
    await db.insert(agents).values([
      { ...agentBase, id: ceoId, name: "CEO", role: "ceo" },
      { ...agentBase, id: ctoId, name: "CTO", role: "cto", reportsTo: ceoId },
      { ...agentBase, id: emId, name: "EM", role: "engineer", reportsTo: ctoId },
      { ...agentBase, id: engId, name: "Eng", role: "engineer", reportsTo: emId },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Deep org stranded work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: engId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });

    // A DELIVERED wake returns the queued run. Null models one of `enqueueWakeup`'s
    // non-delivery paths, which is refunded and spends no budget (BLO-18996 follow-up).
    const enqueueWakeup = vi.fn<
      (agentId: string, opts?: { payload?: unknown }) => Promise<{ id: string }>
    >(async () => ({ id: randomUUID() }));
    const recovery = recoveryService(db, { enqueueWakeup });
    const baseRun = {
      agentId: engId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
      resultJson: null,
      usageJson: null,
      createdAt: new Date(),
    } as const;

    // Re-read the issue every sweep so routing sees the reassignment escalation just made.
    // That is what lets ownership actually churn, which is the whole point here.
    const sweep = async () => {
      const [fresh] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      await recovery.escalateStrandedAssignedIssue({
        issue: fresh!,
        previousStatus: "in_progress",
        latestRun: { ...baseRun, id: randomUUID() },
        comment: "Automatic continuation recovery failed.",
      });
    };

    const SWEEPS = STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS * 4;
    for (let i = 0; i < SWEEPS; i += 1) await sweep();

    // Ownership really is churning, and no single owner ever spent the attempt budget —
    // otherwise this test would be passing for the wrong reason.
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(action!.attemptCount).toBeLessThanOrEqual(STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS);
    const distinctOwnersWoken = new Set(enqueueWakeup.mock.calls.map((call) => call[0]));
    expect(distinctOwnersWoken.size).toBeGreaterThan(1);

    // The horizon is set, and pinned to creation rather than pushed forward each sweep.
    expect(action!.timeoutAt).not.toBeNull();
    const horizon = new Date(action!.timeoutAt as unknown as string).getTime();
    const created = new Date(action!.createdAt as unknown as string).getTime();
    expect(horizon - created).toBeLessThanOrEqual(STRANDED_RECOVERY_OWNER_WAKE_HORIZON_MS + 5_000);

    // Once past the horizon the loop stops for everyone, regardless of whose turn it is.
    const wakesBeforeHorizon = enqueueWakeup.mock.calls.length;
    // Rewind BOTH the column and the evidence key. Since the ownerless-flap fix the
    // horizon's source of truth is `evidence.sourceScopedWakeHorizonAt`, and every
    // `upsertSourceScoped` rewrites `timeoutAt` FROM that key — so rewinding the column
    // alone is undone by the very next sweep and the horizon never reads as reached.
    const pastHorizon = new Date(Date.now() - 1_000);
    await db
      .update(issueRecoveryActions)
      .set({
        timeoutAt: pastHorizon,
        evidence: {
          ...(action!.evidence && typeof action!.evidence === "object" && !Array.isArray(action!.evidence)
            ? (action!.evidence as Record<string, unknown>)
            : {}),
          sourceScopedWakeHorizonAt: pastHorizon.toISOString(),
        },
      })
      .where(eq(issueRecoveryActions.id, action!.id));
    for (let i = 0; i < SWEEPS; i += 1) await sweep();
    expect(enqueueWakeup.mock.calls.length).toBe(wakesBeforeHorizon);

    // And it is announced once, not once per ping-pong sweep — the horizon notice is keyed
    // on the horizon instant precisely because the owner keeps changing underneath it.
    const horizonNotices = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, sourceIssueId))
      .then((rows) =>
        rows.filter((row) =>
          (row.body ?? "").includes(`Recovery wake horizon reached for action \`${action!.id}\``)
        )
      );
    expect(horizonNotices).toHaveLength(1);
  }, 300_000);

  it("bounds provider-quota recovery once it falls through to a manager-ladder owner", async () => {
    // `provider_quota` is monitor-only ONLY when it has no owner. When the quota-hit agent
    // is not invokable, `resolveStrandedRecoveryRouting` falls through to the manager
    // ladder and hands the action a real `ownerAgentId` — which takes the `wake_owner`
    // branch and clears every early return in `enqueueSourceScopedStrandedRecoveryWake`.
    // The budget condition used to exclude the cause outright, so that shape woke its owner
    // on a null budget forever: an unbounded billable loop on the one cause whose whole
    // point is that the provider is refusing to serve us.
    const { managerId, coderId, sourceIssueId } = await seedCompany();
    // Pausing the quota-hit agent is what makes it non-invokable, which is the real-world
    // trigger for the fallback (a paused/terminated agent cannot be retried at reset time).
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, coderId));

    // A DELIVERED wake returns the queued run. Null models one of `enqueueWakeup`'s
    // non-delivery paths, which is refunded and spends no budget (BLO-18996 follow-up).
    const enqueueWakeup = vi.fn<
      (agentId: string, opts?: { payload?: unknown }) => Promise<{ id: string }>
    >(async () => ({ id: randomUUID() }));
    const recovery = recoveryService(db, { enqueueWakeup });
    const quotaRun = {
      agentId: coderId,
      status: "failed",
      error: "Provider usage quota reached for this model.",
      errorCode: "provider_quota",
      contextSnapshot: { issueId: sourceIssueId },
      livenessState: "needs_followup",
      resultJson: null,
      usageJson: null,
      createdAt: new Date(),
    } as const;
    const sweep = async () => {
      const [fresh] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      await recovery.escalateStrandedAssignedIssue({
        issue: fresh!,
        previousStatus: "in_progress",
        latestRun: { ...quotaRun, id: randomUUID() },
        comment: "Provider quota recovery failed.",
      });
    };

    const ESCALATIONS = STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS + 3;
    for (let i = 0; i < ESCALATIONS; i += 1) await sweep();

    // Precondition: this really is the owned provider-quota shape, not the monitor-only one.
    // If routing ever stops falling through, the wake assertion below would pass vacuously.
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(action).toMatchObject({ cause: "provider_quota", ownerAgentId: managerId });
    expect(action!.wakePolicy).toMatchObject({ type: "wake_owner" });

    // The fix, asserted as behaviour first: the owner is woken a bounded number of times
    // rather than once per sweep. Before it, this was `ESCALATIONS` wakes and kept climbing
    // for as long as the sweep ran — the billable loop itself, which is why it is the
    // assertion that should fail if this regresses.
    const wakesToOwner = enqueueWakeup.mock.calls.filter((call) => call[0] === managerId).length;
    expect(wakesToOwner).toBeLessThan(ESCALATIONS);
    expect(wakesToOwner).toBe(STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS);

    // ...and the row carries the same budget and horizon as any other wake_owner action.
    expect(action!.maxAttempts).toBe(STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS);
    expect(action!.timeoutAt).not.toBeNull();
  }, 120_000);

  it("keeps the ownerless provider-quota monitor unbounded, and lets its retry horizon stand", async () => {
    // The other half of the same predicate, pinned so a future tightening of the budget
    // cannot silently manufacture an exhaustion here. An ownerless provider-quota action is
    // a monitor wait: it wakes nobody, is expected to sit open across many sweeps, and the
    // quota scheduler writes its own `timeoutAt = retryAt` on this row. A budget would make
    // `strandedRecoveryWakeAttemptsExhausted` start reading that column as a wake horizon
    // and mistake a normal quota wait for a spent action.
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T21:00:00.000Z"),
      finishedAt: new Date("2026-07-15T21:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    // The agent is invokable, so routing keeps `ownerAgentId` null and the reconcile path
    // schedules a monitor rather than opening an owned action.
    const result = await recovery.reconcileStrandedAssignedIssues();
    expect(result.providerQuotaMonitored).toBe(1);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  }, 120_000);

  it("gives a newly bounded owner a fresh horizon instead of the quota wait's expired one", async () => {
    // The seam between the two provider-quota shapes, on ONE row. While the action is
    // ownerless the quota scheduler parks its `retryAt` in `timeoutAt` with `maxAttempts:
    // null`, which is inert — `strandedRecoveryWakeAttemptsExhausted` short-circuits on the
    // null budget before it reads the horizon. But the same active row gains a manager owner
    // and a budget the moment the quota-hit agent stops being invokable, and a quota
    // `retryAt` is minutes out, so it is in the past by then. Preserving it unconditionally
    // exhausted the new owner on its FIRST wake: the deadlock this ticket fixes, reached
    // through the shared column rather than through the attempt counter.
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const enqueueWakeup = vi.fn<(agentId: string, opts?: { payload?: unknown }) => Promise<null>>(
      async () => null,
    );
    const recovery = recoveryService(db, { enqueueWakeup });
    const quotaRun = {
      agentId: coderId,
      status: "failed",
      error: "Provider usage quota reached for this model.",
      errorCode: "provider_quota",
      contextSnapshot: { issueId: sourceIssueId },
      livenessState: "needs_followup",
      resultJson: null,
      usageJson: null,
      createdAt: new Date(),
    } as const;
    // The ownerless phase schedules a provider-quota retry run whose `retryOfRunId` points at
    // the stranded run, so that run has to actually exist for the FK to hold.
    const sweep = async () => {
      const runId = randomUUID();
      await seedHeartbeatRun({ companyId, agentId: coderId, runId, issueId: sourceIssueId, status: "failed" });
      const [fresh] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      await recovery.escalateStrandedAssignedIssue({
        issue: fresh!,
        previousStatus: "in_progress",
        latestRun: { ...quotaRun, id: runId },
        comment: "Provider quota recovery failed.",
      });
    };

    // Phase 1 — the agent is still invokable, so this is the ownerless monitor shape.
    await sweep();
    const [ownerless] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(ownerless).toMatchObject({ cause: "provider_quota", ownerAgentId: null, maxAttempts: null });

    // The quota wait elapses. Pinned directly rather than slept through: this is exactly the
    // state the scheduler's `timeoutAt = retryAt` leaves behind once its retry instant passes.
    const expiredRetryAt = new Date(Date.now() - 60_000);
    await db
      .update(issueRecoveryActions)
      .set({ timeoutAt: expiredRetryAt })
      .where(eq(issueRecoveryActions.id, ownerless!.id));

    // Phase 2 — the quota-hit agent is no longer invokable, so routing falls through to the
    // manager ladder and this same row becomes an owner-waking, budgeted action.
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, coderId));
    await sweep();

    const [bounded] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, ownerless!.id));
    // Same row, now owned and budgeted — the precondition that makes the horizon load-bearing.
    expect(bounded).toMatchObject({
      ownerAgentId: managerId,
      maxAttempts: STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS,
    });

    // The fix, asserted as behaviour first: the new owner actually gets woken. Before it, the
    // inherited expired `retryAt` made this zero.
    expect(enqueueWakeup.mock.calls.filter((call) => call[0] === managerId).length).toBeGreaterThan(0);

    // ...because the horizon was re-anchored when the bound began, not inherited.
    expect(bounded!.timeoutAt).not.toBeNull();
    expect(new Date(bounded!.timeoutAt as unknown as string).getTime())
      .toBeGreaterThan(expiredRetryAt.getTime());
    expect(new Date(bounded!.timeoutAt as unknown as string).getTime()).toBeGreaterThan(Date.now());

    // Phase 3 — and the re-anchor is a ONE-TIME transition, not a per-sweep refresh. This is
    // the failure mode the horizon exists to avoid, so it has to be pinned on the branch that
    // writes it too: re-deriving from `now` on every pass pushes the horizon ahead of the
    // sweep forever and bounds nothing, which is how the attempt counter failed first.
    const anchored = new Date(bounded!.timeoutAt as unknown as string).getTime();
    await sweep();
    const [afterAnotherSweep] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, ownerless!.id));
    expect(new Date(afterAnotherSweep!.timeoutAt as unknown as string).getTime()).toBe(anchored);
  }, 120_000);

  it("does not refresh the wake horizon after a bounded action temporarily loses its owner", async () => {
    const { managerId, coderId, sourceIssueId } = await seedCompany();
    const enqueueWakeup = vi.fn<(agentId: string, opts?: { payload?: unknown }) => Promise<{ id: string }>>(
      async () => ({ id: randomUUID() }),
    );
    const recovery = recoveryService(db, { enqueueWakeup });
    const baseRun = {
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
      resultJson: null,
      usageJson: null,
      createdAt: new Date(),
    } as const;
    const sweep = async () => {
      const [fresh] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      await recovery.escalateStrandedAssignedIssue({
        issue: fresh!,
        previousStatus: "in_progress",
        latestRun: { ...baseRun, id: randomUUID(), createdAt: new Date() },
        comment: "Automatic continuation recovery failed.",
      });
    };
    const wakesToManager = () => enqueueWakeup.mock.calls.filter((call) => call[0] === managerId).length;

    await sweep();
    const [bounded] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(bounded).toMatchObject({
      ownerAgentId: managerId,
      maxAttempts: STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS,
    });
    expect(wakesToManager()).toBe(1);
    const originalHorizonMs = new Date(bounded!.timeoutAt as unknown as string).getTime();
    expect(Number.isFinite(originalHorizonMs)).toBe(true);

    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, managerId));
    await sweep();
    const [ownerless] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, bounded!.id));
    expect(ownerless).toMatchObject({ ownerAgentId: null, maxAttempts: null });
    expect(new Date(ownerless!.timeoutAt as unknown as string).getTime()).toBe(originalHorizonMs);
    expect(wakesToManager()).toBe(1);

    // Fake ONLY `Date`. This block performs Postgres I/O (`db.update`, and the selects and
    // updates inside `sweep()`), and the pg driver depends on the real timer wheel for
    // pool acquisition and socket handling — installing the full fake-timer set here
    // deadlocks the query until the 120s test timeout and then wedges the cleanup hook
    // too, which is what stalled the whole `server 2/4` shard. Moving the clock is all
    // this test needs: the service reads the horizon off `Date.now()`.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(originalHorizonMs + 1_000));
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, managerId));
      await sweep();
    } finally {
      vi.useRealTimers();
    }

    const [rebounded] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, bounded!.id));
    expect(rebounded).toMatchObject({
      ownerAgentId: managerId,
      maxAttempts: STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS,
    });
    expect(new Date(rebounded!.timeoutAt as unknown as string).getTime()).toBe(originalHorizonMs);
    expect(wakesToManager()).toBe(1);
    expect(strandedRecoveryWakeAttemptsExhausted(rebounded!, new Date(originalHorizonMs + 1_000))).toBe(true);

    const horizonNotices = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, sourceIssueId))
      .then((rows) =>
        rows.filter((row) =>
          (row.body ?? "").includes(`Recovery wake horizon reached for action \`${bounded!.id}\``)
        )
      );
    expect(horizonNotices).toHaveLength(1);
  }, 120_000);

  it("does not spend the wake budget on enqueue failures that woke nobody", async () => {
    // `upsertSourceScoped` increments `attemptCount` on the service's own connection, which
    // commits before the wake is enqueued and outside `escalateStrandedAssignedIssue`'s
    // transaction — so a rollback cannot take the attempt back. Transient enqueue failures
    // therefore used to retire the budget having woken nobody, after which the guard skipped
    // the enqueue permanently and the exhaustion notice claimed N wakes that never happened.
    const { managerId, coderId, sourceIssueId } = await seedCompany();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, coderId));

    // One more failure than the budget, deliberately. A count below the budget would prove
    // the counter moved but not the consequence: the point of the leak is that it drives the
    // action into exhaustion, after which the guard skips the enqueue permanently. Only
    // FAILURES > maxAttempts exercises that.
    const FAILURES = STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS + 1;
    let enqueueFails = true;
    // NOTE (BLO-18996 review follow-up): the delivered branch must return a RUN, not null.
    // `enqueueWakeup` returns null on all nine of its non-delivery paths, so a null-returning
    // "recovered" fixture would be asserting that a wake nobody received still spends budget
    // — the precise inversion of the invariant under test. A truthy run is the only outcome
    // that means the wake reached the queue.
    const queuedRun = { id: randomUUID() } as never;
    const enqueueWakeup = vi.fn(async () => {
      if (enqueueFails) throw new Error("transient wakeup enqueue failure");
      return queuedRun;
    });
    const recovery = recoveryService(db, { enqueueWakeup });
    const quotaRun = {
      agentId: coderId,
      status: "failed",
      error: "Provider usage quota reached for this model.",
      errorCode: "provider_quota",
      contextSnapshot: { issueId: sourceIssueId },
      livenessState: "needs_followup",
      resultJson: null,
      usageJson: null,
      createdAt: new Date(),
    } as const;
    const sweep = async () => {
      const [fresh] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      // The enqueue failure propagates out of the escalation by design — the point is that it
      // must not silently consume budget on its way out.
      await recovery.escalateStrandedAssignedIssue({
        issue: fresh!,
        previousStatus: "in_progress",
        latestRun: { ...quotaRun, id: randomUUID() },
        comment: "Provider quota recovery failed.",
      }).catch(() => null);
    };

    for (let i = 0; i < FAILURES; i += 1) await sweep();

    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    // Precondition: this really is the budgeted owner-waking shape, so `attemptCount` here is
    // the wake budget and not some unbounded bookkeeping counter.
    expect(action).toMatchObject({
      ownerAgentId: managerId,
      maxAttempts: STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS,
    });
    // Every sweep tried to wake and every one of them threw, so the enqueue was genuinely
    // exercised — the assertion below is not passing because nothing happened. Pre-fix this
    // is FAILURES - 1: the last sweep found the budget already retired by the leaked
    // increments and skipped the enqueue entirely, for an action that had woken nobody.
    expect(enqueueWakeup.mock.calls.length).toBe(FAILURES);

    // The fix, stated as the invariant the reviewer named: a wake that never reached the
    // queue does not spend budget. Pre-fix each failed sweep left its increment committed, so
    // this was FAILURES and marched toward exhaustion without anyone ever being woken.
    expect(action!.attemptCount).toBe(0);
    expect(strandedRecoveryWakeAttemptsExhausted(action!)).toBe(false);

    // ...and the consequence that matters: the owner is still reachable once the transient
    // failure clears. Pre-fix the budget was already gone and this was zero further wakes,
    // permanently — the undischargeable action this ticket exists to prevent.
    enqueueFails = false;
    const callsBeforeRecovery = enqueueWakeup.mock.calls.length;
    await sweep();
    expect(enqueueWakeup.mock.calls.length).toBeGreaterThan(callsBeforeRecovery);

    // The refund is scoped to a wake that woke nobody, not a blanket exemption: a wake that
    // DID reach the queue still spends its attempt. Without this the loop would simply be
    // unbounded again. It lands on exactly 1 because the refunds floored at 0, so the first
    // delivered wake is the first counted attempt — which is what the floor is for.
    const [afterDelivery] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(afterDelivery!.attemptCount).toBe(1);
  }, 180_000);

  it("does not spend the wake budget on deferred enqueues that queued no run", async () => {
    // BLO-18996 (review follow-up). The sibling test above covers the enqueue that THROWS.
    // This one covers the outcome that is far more common in production and looks like
    // success from the call site: `enqueueWakeup` resolving to null.
    //
    // Null is not an error — it is how the enqueue reports its non-delivery paths. Nine of
    // them: provider-capacity deferral via `checkPenstockAvailabilityForAgent`, an active
    // tree pause hold, heartbeat disabled, wake-on-demand disabled, cooldown active, the
    // no-actionable-timer-work skip, and the worktree-execution cutoff. Each writes a
    // *skipped* request row or nothing at all; none queues a run. Counting them against the
    // budget retires the action during ordinary deferral, having woken nobody — and the
    // exhaustion notice then reports N wakes that never happened.
    const { managerId, coderId, sourceIssueId } = await seedCompany();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, coderId));

    // Deliberately more than the budget: below it we would only prove the counter did not
    // move, not the consequence — that the deferrals never drive the action into exhaustion.
    const DEFERRALS = STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS + 2;
    let deferred = true;
    const queuedRun = { id: randomUUID() } as never;
    const enqueueWakeup = vi.fn(async () => (deferred ? null : queuedRun));
    const recovery = recoveryService(db, { enqueueWakeup });
    const quotaRun = {
      agentId: coderId,
      status: "failed",
      error: "Provider usage quota reached for this model.",
      errorCode: "provider_quota",
      contextSnapshot: { issueId: sourceIssueId },
      livenessState: "needs_followup",
      resultJson: null,
      usageJson: null,
      createdAt: new Date(),
    } as const;
    const sweep = async () => {
      const [fresh] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      await recovery.escalateStrandedAssignedIssue({
        issue: fresh!,
        previousStatus: "in_progress",
        latestRun: { ...quotaRun, id: randomUUID() },
        comment: "Provider quota recovery deferred.",
      });
    };

    for (let i = 0; i < DEFERRALS; i += 1) await sweep();

    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    // Precondition: the budgeted owner-waking shape, so `attemptCount` here is the wake
    // budget rather than unbounded bookkeeping.
    expect(action).toMatchObject({
      ownerAgentId: managerId,
      maxAttempts: STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS,
    });
    // Every sweep genuinely reached the enqueue — the assertions below are not passing
    // because the guard skipped the call.
    expect(enqueueWakeup.mock.calls.length).toBe(DEFERRALS);
    // Note this deliberately asserts on rows and budget rather than on call count: an
    // invocation is not a queued wake, and counting invocations is what let the wrong
    // invariant through review in the first place.
    expect(action!.attemptCount).toBe(0);
    expect(strandedRecoveryWakeAttemptsExhausted(action!)).toBe(false);

    // The lifecycle assertion: once capacity frees up, the owner is still reachable AND the
    // first genuinely queued wake spends exactly one attempt. Pre-fix the budget was long
    // gone by here and this was zero further wakes, permanently.
    deferred = false;
    const callsBeforeDelivery = enqueueWakeup.mock.calls.length;
    await sweep();
    expect(enqueueWakeup.mock.calls.length).toBeGreaterThan(callsBeforeDelivery);
    const [afterDelivery] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(afterDelivery!.attemptCount).toBe(1);
  }, 180_000);

  it("refunds a suppressed non-assignee wake when the source issue has no assignee fallback", async () => {
    const { managerId, coderId, sourceIssueId } = await seedCompany();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, coderId));

    const queuedRun = { id: randomUUID() } as never;
    const enqueueWakeup = vi.fn(async () => queuedRun);
    const recovery = recoveryService(db, { enqueueWakeup });
    const failedRun = {
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { issueId: sourceIssueId },
      livenessState: "needs_followup",
      resultJson: null,
      usageJson: null,
      createdAt: new Date(),
    } as const;
    const sweep = async () => {
      const [fresh] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      await recovery.escalateStrandedAssignedIssue({
        issue: fresh!,
        previousStatus: "in_progress",
        latestRun: { ...failedRun, id: randomUUID() },
        comment: "Automatic continuation recovery failed.",
        recoveryOwnerAgentId: managerId,
      });
    };

    await sweep();
    const [afterFirst] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(afterFirst).toMatchObject({
      ownerAgentId: managerId,
      maxAttempts: STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS,
      attemptCount: 1,
    });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);

    await db
      .update(issues)
      .set({
        assigneeAgentId: null,
        // Establish the unchanged-state precondition explicitly. The first escalation's
        // system comment otherwise counts as new activity and correctly permits another wake.
        lastActivityAt: new Date(afterFirst!.lastAttemptAt as Date | string),
      })
      .where(eq(issues.id, sourceIssueId));

    await sweep();

    const [afterSuppressed] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(afterSuppressed!.attemptCount).toBe(1);
    expect(strandedRecoveryWakeAttemptsExhausted(afterSuppressed!)).toBe(false);
  }, 180_000);

  it("still refunds the attempt when the first refund write fails", async () => {
    // BLO-18996 (review follow-up). The refund is itself a separate database write on the
    // service's own connection, so it can fail on its own. It must not rethrow — on the
    // throwing-enqueue path that would mask the enqueue's error, which is the more
    // diagnostic one — but discarding it silently recreates the accounting leak it exists to
    // compensate. One retry covers the transient blip; a final failure is logged under a
    // stable message rather than dropped.
    //
    // This pins the consequence: with the enqueue AND the first refund write both failing on
    // every sweep, the owner must still be reachable afterwards.
    const { managerId, coderId, sourceIssueId } = await seedCompany();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, coderId));

    const FAILURES = STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS + 1;
    let enqueueFails = true;
    const queuedRun = { id: randomUUID() } as never;
    const enqueueWakeup = vi.fn(async () => {
      if (enqueueFails) throw new Error("transient wakeup enqueue failure");
      return queuedRun;
    });
    const recovery = recoveryService(db, { enqueueWakeup });
    const quotaRun = {
      agentId: coderId,
      status: "failed",
      error: "Provider usage quota reached for this model.",
      errorCode: "provider_quota",
      contextSnapshot: { issueId: sourceIssueId },
      livenessState: "needs_followup",
      resultJson: null,
      usageJson: null,
      createdAt: new Date(),
    } as const;
    const sweep = async () => {
      const [fresh] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      await recovery.escalateStrandedAssignedIssue({
        issue: fresh!,
        previousStatus: "in_progress",
        latestRun: { ...quotaRun, id: randomUUID() },
        comment: "Provider quota recovery failed.",
      }).catch(() => null);
    };

    try {
      // Exactly one failure per sweep, so the retry is what has to save it. Arming two would
      // instead assert the give-up path, which by design leaves the attempt spent.
      for (let i = 0; i < FAILURES; i += 1) {
        releaseWakeAttemptFailures = 1;
        await sweep();
      }
    } finally {
      releaseWakeAttemptFailures = null;
    }

    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(action).toMatchObject({
      ownerAgentId: managerId,
      maxAttempts: STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS,
    });
    expect(enqueueWakeup.mock.calls.length).toBe(FAILURES);
    // The retry landed every time, so the budget is intact despite every first write failing.
    expect(action!.attemptCount).toBe(0);
    expect(strandedRecoveryWakeAttemptsExhausted(action!)).toBe(false);

    // The consequence Ally asked to see pinned: the owner is still reachable.
    enqueueFails = false;
    const callsBeforeRecovery = enqueueWakeup.mock.calls.length;
    await sweep();
    expect(enqueueWakeup.mock.calls.length).toBeGreaterThan(callsBeforeRecovery);
    const [afterDelivery] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(afterDelivery!.attemptCount).toBe(1);
  }, 180_000);

  it("deduplicates workspace-incoherence recovery actions by the typed workspace fingerprint", async () => {
    const { companyId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const workspaceFingerprint = `workspace_incoherence:v1:sha256:${"a".repeat(64)}`;
    const workspaceValidation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: workspaceFingerprint,
      sourceIssueId: sourceIssue.id,
      sourceIdentifier: sourceIssue.identifier,
      executionWorkspaceId: "execution-workspace-1",
      expectedBranch: "PAP-1-expected",
      actualBranch: "PAP-1-publish",
      cleanliness: "dirty",
      provenance: {
        expectedBranchExists: true,
        actualBranchExists: true,
        expectedHeadSha: "1111111111111111111111111111111111111111",
        actualHeadSha: "2222222222222222222222222222222222222222",
        sameHead: false,
      },
      safeRepair: {
        eligible: false,
        attempted: false,
        succeeded: false,
        reason: "worktree is not clean",
      },
    };
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "workspace branch mismatch",
      errorCode: "workspace_validation_failed",
      contextSnapshot: {},
      livenessState: "failed",
      resultJson: { workspaceValidation },
    } as const;
    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Workspace failed validation.",
      recoveryCause: "workspace_validation_failed",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Workspace failed validation.",
      recoveryCause: "workspace_validation_failed",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "workspace_validation",
      cause: "workspace_validation_failed",
      status: "active",
      attemptCount: 2,
      fingerprint: expect.stringContaining(workspaceFingerprint),
      evidence: expect.objectContaining({
        latestRunId: secondLatestRun.id,
        latestRunErrorCode: "workspace_validation_failed",
        workspaceValidation: expect.objectContaining({
          reason: "git_worktree_branch_incoherence",
          fingerprint: workspaceFingerprint,
          sourceIssueId: sourceIssue.id,
          executionWorkspaceId: "execution-workspace-1",
          expectedBranch: "PAP-1-expected",
          actualBranch: "PAP-1-publish",
          cleanliness: "dirty",
        }),
      }),
      nextAction: expect.stringContaining("git worktree branch incoherence"),
      wakePolicy: expect.objectContaining({
        type: "manual_repair_required",
        reason: "workspace_validation_failed",
        ownerAgentId: expect.any(String),
      }),
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    expect(comments.filter((comment) => comment.body.includes(`Recovery action: \`${actionRows[0]?.id}\``))).toHaveLength(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("keeps the source issue blocked when source-scoped wakeup is claimed synchronously", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, managerId));
    // The wake is CLAIMED here — the fixture picks the issue up synchronously — so it is a
    // delivered wake and must return the queued run. Returning null would model a
    // non-delivery, which is refunded and spends no budget (BLO-18996 follow-up), and the
    // `attemptCount: 2` below would then read 0.
    const enqueueWakeup = vi.fn(async () => {
      await db
        .update(issues)
        .set({ status: "in_progress" })
        .where(eq(issues.id, sourceIssue.id));
      return { id: randomUUID() } as never;
    });
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
      resultJson: null,
      usageJson: null,
      createdAt: new Date(),
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const [afterFirst] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterFirst?.status).toBe("blocked");
    expect(afterFirst?.assigneeAgentId).toBe(coderId);

    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    const [afterSecond] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterSecond?.status).toBe("blocked");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Recovery action:");
  });

  it("does not create nested recovery artifacts when issue-backed fallback work itself fails", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const recoveryIssueId = randomUUID();
    await db.insert(issues).values({
      id: recoveryIssueId,
      companyId,
      title: "Recover stalled issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: managerId,
      parentId: sourceIssueId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
      originKind: "stranded_issue_recovery",
      originId: sourceIssueId,
      originFingerprint: `stranded_issue_recovery:${sourceIssueId}`,
    });
    const [recoveryIssue] = await db.select().from(issues).where(eq(issues.id, recoveryIssueId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await recovery.escalateStrandedAssignedIssue({
      issue: recoveryIssue!,
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: managerId,
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
        resultJson: null,
        usageJson: null,
        createdAt: new Date(),
      },
    });

    const actionRows = await db.select().from(issueRecoveryActions);
    expect(actionRows).toHaveLength(0);
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(1);
    expect(recoveryIssues[0]?.status).toBe("blocked");
  });

  it("exposes active recovery actions on the issue read API", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({
      id: action.id,
      sourceIssueId,
      kind: "missing_disposition",
      ownerAgentId: managerId,
    });

    const list = await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions`).expect(200);
    expect(list.body.active).toMatchObject({ id: action.id });
    expect(list.body.actions).toHaveLength(1);
  });

  it("projects recovery action metadata into the structured wake payload", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:wake-payload",
      evidence: {
        failureSummary: "Worktree branch does not match the pinned branch.",
        routingFallbackReason: null,
      },
      nextAction: "Repair the worktree, then return the issue to the coder.",
      wakePolicy: { type: "wake_owner" },
      maxAttempts: 3,
    });

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId: sourceIssueId,
        wakeReason: "source_scoped_recovery_action",
        recoveryActionId: action.id,
        recoveryCause: action.cause,
      },
    });

    expect(payload?.recovery).toEqual({
      cause: "workspace_validation_failed",
      failureSummary: "Worktree branch does not match the pinned branch.",
      originalAssignee: { id: coderId, name: "Coder" },
      attemptCount: 1,
      maxAttempts: 3,
      nextAction: "Repair the worktree, then return the issue to the coder.",
      routingFallbackReason: null,
    });
  });

  it("resolves an active recovery action and removes it from active projections", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Operator confirmed the source issue is complete.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "owner_completed",
      resolutionNote: "Operator confirmed the source issue is complete.",
    });
    expect(resolved.body.recoveryAction.resolvedAt).toBeTruthy();
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["issue.updated", "issue.recovery_action_resolved"]),
    );
  });

  it("hands restored work back to the recorded return owner and records the outcome", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: managerId })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Repair the workspace and hand the issue back.",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueRecoveryActionWakeup = vi.fn(async () => null);
    const resolved = await request(createApp(undefined, {
      recoveryActionEnqueueWakeup: enqueueRecoveryActionWakeup,
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Workspace repaired.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      assigneeAgentId: coderId,
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "handed_back",
    });
    expect(enqueueRecoveryActionWakeup).toHaveBeenCalledWith(
      coderId,
      expect.objectContaining({
        reason: "issue_recovery_action_restored",
        payload: expect.objectContaining({ issueId: sourceIssueId, recoveryActionId: action.id }),
      }),
    );
  });

  it("does not enqueue a restored wake when todo status and assignee are unchanged", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "todo", assigneeAgentId: coderId })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:already-restored",
      evidence: { latestRunId: "run-1" },
      nextAction: "Confirm the workspace remains healthy.",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueRecoveryActionWakeup = vi.fn(async () => null);
    await request(createApp(undefined, {
      recoveryActionEnqueueWakeup: enqueueRecoveryActionWakeup,
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Workspace was already restored.",
      })
      .expect(200);

    expect(enqueueRecoveryActionWakeup).not.toHaveBeenCalled();
  });

  it("resolves an active recovery action by returning the source issue to todo", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:try-again",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Try the source issue again.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "restored",
      resolutionNote: "Try the source issue again.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
  });

  it("marks a recovery action stale when a blocked source issue is manually moved to todo", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:manual-restore",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const patched = await request(app)
      .patch(`/api/issues/${sourceIssueId}`)
      .send({ status: "todo" })
      .expect(200);

    expect(patched.body).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      activeRecoveryAction: null,
    });

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue was manually moved from blocked to todo.",
    });
    expect(actionRow?.resolvedAt).toBeTruthy();
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["issue.updated", "issue.recovery_action_resolved"]),
    );
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "issue_update",
    });
  });

  it("folds stale recovery during read projection after the source issue reaches done", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:done-projection",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, sourceIssueId));
    const app = createApp();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);

    expect(detail.body).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue reached done.",
    });
    expect(actionRow?.resolvedAt).toBeTruthy();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "read_projection",
      recoveryActionId: action.id,
    });
  });

  it("keeps active recovery visible when a plain comment does not create a live path", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:plain-comment",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/comments`)
      .send({ body: "I am looking at this, but not changing the disposition." })
      .expect(201);

    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toMatchObject({
      id: action.id,
      status: "active",
    });
    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({ id: action.id });
  });

  it("folds stale recovery when a structured resume comment restores todo dispatch", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:resume-comment",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/comments`)
      .send({ body: "Resume this now.", resume: true })
      .expect(201);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("todo");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue was manually moved from blocked to todo.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "comment",
      recoveryActionId: action.id,
    });
  });

  it("rejects peer-agent source issue updates that would hide another owner's recovery action", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:peer-status-update",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp({
      type: "agent",
      agentId: coderId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .patch(`/api/issues/${sourceIssueId}`)
      .send({ status: "todo" })
      .expect(403);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("blocked");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("rejects peer-agent recovery action resolution on a board-owned source issue", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:peer-resolution",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp({
      type: "agent",
      agentId: coderId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Peer agent should not be able to clear this recovery.",
      })
      .expect(403);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("blocked");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("allows the named recovery owner to resolve a board-owned source recovery action", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:owner-resolution",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const runId = randomUUID();
    const app = createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId,
      source: "agent_jwt",
    });
    await seedHeartbeatRun({
      companyId,
      agentId: managerId,
      runId,
      issueId: sourceIssueId,
    });

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Recovery owner verified the work was intentionally completed.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "owner_completed",
    });
  });

  it("allows the named recovery owner to resolve another assignee's review-waiting source issue", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({
        status: "blocked",
        assigneeAgentId: coderId,
        monitorNextCheckAt: new Date(Date.now() + 60_000),
      })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:review-waiting-owner-resolution",
      evidence: { latestIssueStatus: "blocked", latestRunErrorCode: "issue_continuation_waiting_on_review" },
      nextAction: "Set the source issue to an explicit review-waiting disposition.",
      wakePolicy: { type: "manual" },
    });
    const runId = randomUUID();
    await seedHeartbeatRun({
      companyId,
      agentId: managerId,
      runId,
      issueId: sourceIssueId,
    });
    const app = createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "in_review",
        resolutionNote: "Recovery owner verified this issue is waiting on PR review/CI and has an active monitor.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "in_review",
      assigneeAgentId: coderId,
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "restored",
    });
  });

  it("allows the named recovery owner to resolve another assignee's checked-out source issue", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ monitorNextCheckAt: new Date(Date.now() + 60_000) })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:checked-out-owner-resolution",
      evidence: { latestIssueStatus: "in_progress", latestRunErrorCode: "issue_continuation_waiting_on_review" },
      nextAction: "Set the source issue to an explicit review-waiting disposition.",
      wakePolicy: { type: "manual" },
    });
    const runId = randomUUID();
    await seedHeartbeatRun({
      companyId,
      agentId: managerId,
      runId,
      issueId: sourceIssueId,
    });
    const app = createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "in_review",
        resolutionNote: "Recovery owner verified this issue is waiting on PR review/CI and has an active monitor.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "in_review",
      assigneeAgentId: coderId,
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "restored",
    });
  });

  it("rejects blocked recovery resolution when the source issue has no first-class blockers", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-without-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Choose a disposition with a live continuation path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const rejected = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
      })
      .expect(422);

    expect(rejected.body.error).toContain("requires an unresolved first-class blocker");

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("allows blocked recovery resolution when the source issue has an unresolved first-class blocker", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Unblock recovery disposition",
      status: "todo",
      priority: "medium",
      assigneeAgentId: managerId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-with-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Wait for the blocker before continuing.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
        resolutionNote: "The source issue is explicitly blocked by a follow-up.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "blocked",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "blocked",
      resolutionNote: "The source issue is explicitly blocked by a follow-up.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
  });

  it("rejects false-positive recovery resolution without an explicit source issue status", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:fingerprint",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        resolutionNote: "The source issue still has a live execution path.",
      })
      .expect(400);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolutionNote: null,
    });
  });

  it("allows false-positive recovery resolution to restore a blocked source issue in the same request", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:false-positive-unblock",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        sourceIssueStatus: "in_review",
        resolutionNote: "Recovery signal was stale; return to review.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "in_review",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "false_positive",
      resolutionNote: "Recovery signal was stale; return to review.",
    });
  });

  it("enforces company scope when resolving recovery actions", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp({
      type: "agent",
      agentId: randomUUID(),
      companyId: randomUUID(),
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
      })
      .expect(404);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow?.status).toBe("active");
  });

  // BLO-18860: adopting a stale checkout is a HANDOVER, not a failure.
  // Reproduces the live BLO-18237 sequence: the assignee PATCHes an issue whose
  // checkout is held by its own dead run, the PATCH adopts the checkout and
  // cancels the issue's queued context run with `issue_checkout_adopted`, and
  // the recovery sweep then read that cancellation as evidence the issue was
  // stranded — reassigning it up the org chart and taking the annotating
  // agent's write access with it.
  describe("checkout adoption is not stranding evidence", () => {
    // The adopting run is deliberately scoped to a DIFFERENT issue: that is the
    // hazardous shape (an agent touching a stale issue from a run dispatched
    // for other work), and it is invisible to `hasActiveExecutionPath`, which
    // matches on `contextSnapshot ->> 'issueId'`.
    async function seedAdoptedCheckout(input: { adoptingRunStatus: string }) {
      const seeded = await seedCompany();
      const deadCheckoutRunId = randomUUID();
      const queuedContextRunId = randomUUID();
      const adoptingRunId = randomUUID();
      const otherIssueId = randomUUID();

      await db.insert(heartbeatRuns).values([
        {
          id: deadCheckoutRunId,
          companyId: seeded.companyId,
          agentId: seeded.coderId,
          invocationSource: "automation",
          status: "failed",
          errorCode: "process_lost",
          contextSnapshot: { issueId: seeded.sourceIssueId },
          createdAt: new Date("2026-07-29T10:00:00.000Z"),
          finishedAt: new Date("2026-07-29T10:05:00.000Z"),
        },
        {
          id: queuedContextRunId,
          companyId: seeded.companyId,
          agentId: seeded.coderId,
          invocationSource: "automation",
          status: "queued",
          // The sweep's own continuation retry — this is what makes the
          // pre-fix path escalate rather than re-dispatch: the cancellation
          // counts as a spent continuation attempt (maxAttempts 1).
          contextSnapshot: {
            issueId: seeded.sourceIssueId,
            retryReason: "issue_continuation_needed",
          },
          createdAt: new Date("2026-07-29T11:00:00.000Z"),
        },
        {
          id: adoptingRunId,
          companyId: seeded.companyId,
          agentId: seeded.coderId,
          invocationSource: "timer",
          status: input.adoptingRunStatus,
          contextSnapshot: { issueId: otherIssueId },
          createdAt: new Date("2026-07-29T12:00:00.000Z"),
          startedAt: new Date("2026-07-29T12:00:00.000Z"),
        },
      ]);
      await db
        .update(issues)
        .set({
          checkoutRunId: deadCheckoutRunId,
          executionRunId: deadCheckoutRunId,
          executionAgentNameKey: "coder",
          executionLockedAt: new Date("2026-07-29T10:00:00.000Z"),
        })
        .where(eq(issues.id, seeded.sourceIssueId));

      return { ...seeded, deadCheckoutRunId, queuedContextRunId, adoptingRunId };
    }

    function agentActor(companyId: string, agentId: string, runId: string) {
      return { type: "agent", agentId, companyId, runId, source: "agent_jwt" } as const;
    }

    it("keeps the assignee after its own PATCH adopts a dead same-agent checkout", async () => {
      const { companyId, coderId, sourceIssueId, queuedContextRunId, adoptingRunId } =
        await seedAdoptedCheckout({ adoptingRunStatus: "running" });

      const res = await request(createApp(agentActor(companyId, coderId, adoptingRunId)))
        .patch(`/api/issues/${sourceIssueId}`)
        .send({ title: "Annotated while stalled" });

      // (a)+(b): the assignee's write on its own stale issue succeeds and
      // adopts the checkout, cancelling the older context run.
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const [adoptedContextRun] = await db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedContextRunId));
      expect(adoptedContextRun).toEqual({
        status: "cancelled",
        errorCode: "issue_checkout_adopted",
      });
      const [afterPatch] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      expect(afterPatch).toMatchObject({
        executionRunId: adoptingRunId,
        checkoutRunId: adoptingRunId,
        assigneeAgentId: coderId,
      });

      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      const result = await recovery.reconcileStrandedAssignedIssues();

      // (c): the handover produces no recovery action, no reassignment, and no
      // status change — the live same-assignee run is continuity.
      expect(result).toMatchObject({ escalated: 0, continuationRequeued: 0 });
      expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
      expect(enqueueWakeup).not.toHaveBeenCalled();
      const [reconciled] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      expect(reconciled).toMatchObject({
        status: "in_progress",
        assigneeAgentId: coderId,
      });
    });

    it("re-dispatches to the assignee instead of escalating when the adopting run also died", async () => {
      const { companyId, coderId, sourceIssueId, adoptingRunId } = await seedAdoptedCheckout({
        adoptingRunStatus: "running",
      });

      const res = await request(createApp(agentActor(companyId, coderId, adoptingRunId)))
        .patch(`/api/issues/${sourceIssueId}`)
        .send({ title: "Annotated while stalled" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      // The adopting run then dies without clearing the lock, so the handover
      // marker is still the newest run scoped to this issue. Recovery must judge
      // the issue on the adopting run's own outcome — which here is a plain
      // failure with no spent continuation budget, so the assignee gets another
      // run rather than losing the issue to its manager.
      await db
        .update(heartbeatRuns)
        .set({
          status: "failed",
          error: "adopting run died",
          finishedAt: new Date("2026-07-29T12:30:00.000Z"),
        })
        .where(eq(heartbeatRuns.id, adoptingRunId));

      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      const result = await recovery.reconcileStrandedAssignedIssues();

      expect(result.escalated).toBe(0);
      expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
      // The assignee is woken for another continuation attempt instead of
      // losing the issue to its manager on the strength of the handover marker.
      expect(enqueueWakeup).toHaveBeenCalledWith(
        coderId,
        expect.objectContaining({
          reason: "issue_continuation_needed",
          payload: expect.objectContaining({ issueId: sourceIssueId }),
        }),
      );
      const [reconciled] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      expect(reconciled).toMatchObject({
        status: "in_progress",
        assigneeAgentId: coderId,
      });
    });

    // Ally's review of PR #824: the sibling test above deliberately leaves the
    // dead adopter holding the lock, so it never exercises what production
    // actually does next. `clearCheckoutRunIfTerminal` nulls BOTH lock columns
    // once the adopter is terminal (services/issues.ts) — after which
    // `getCheckoutAdoptingRun` has no run id to resolve and returns null. The
    // handover marker is still the newest run scoped to this issue and always
    // will be, so without the successor-less branch every later sweep walks the
    // same path and the no-run/no-lock guard skips the issue forever: a genuine
    // strand that never gets recovered.
    it("recovers the adopted issue after the adopter terminates and production cleanup clears the lock", async () => {
      const { companyId, coderId, sourceIssueId, adoptingRunId } = await seedAdoptedCheckout({
        adoptingRunStatus: "running",
      });

      const res = await request(createApp(agentActor(companyId, coderId, adoptingRunId)))
        .patch(`/api/issues/${sourceIssueId}`)
        .send({ title: "Annotated while stalled" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      // The adopter finishes NORMALLY — not the "died holding the lock" shape.
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded", finishedAt: new Date("2026-07-29T12:30:00.000Z") })
        .where(eq(heartbeatRuns.id, adoptingRunId));

      // Drive the real cleanup helper rather than nulling the columns by hand,
      // so the test fails if that helper's clearing behaviour ever changes.
      await expect(issueService(db).clearCheckoutRunIfTerminal(sourceIssueId)).resolves.toBe(true);
      const [afterCleanup] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      expect(afterCleanup).toMatchObject({ checkoutRunId: null, executionRunId: null });

      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      const result = await recovery.reconcileStrandedAssignedIssues();

      // Recovered, not skipped: the assignee is woken to continue its own
      // issue. The wake call is the signal rather than `continuationRequeued`,
      // because the mocked `enqueueWakeup` returns null and the counter only
      // moves on a truthy queue result.
      expect(result).toMatchObject({ escalated: 0 });
      expect(enqueueWakeup).toHaveBeenCalledWith(
        coderId,
        expect.objectContaining({
          reason: "issue_continuation_needed",
          payload: expect.objectContaining({ issueId: sourceIssueId }),
        }),
      );
      // And still no escalation citing the handover marker as the cause.
      expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
      const [afterSweep] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      expect(afterSweep).toMatchObject({
        status: "in_progress",
        assigneeAgentId: coderId,
      });
    });

    it("still escalates a genuinely stranded issue after a spent continuation retry", async () => {
      const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
      const failedRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: failedRunId,
        companyId,
        agentId: coderId,
        invocationSource: "automation",
        status: "failed",
        error: "worker crashed before reporting a disposition",
        errorCode: "run_crashed",
        contextSnapshot: {
          issueId: sourceIssueId,
          retryReason: "issue_continuation_needed",
        },
        createdAt: new Date("2026-07-29T11:00:00.000Z"),
        finishedAt: new Date("2026-07-29T11:05:00.000Z"),
      });
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });

      const result = await recovery.reconcileStrandedAssignedIssues();

      expect(result.escalated).toBe(1);
      const [action] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
      expect(action).toMatchObject({
        kind: "stranded_assigned_issue",
        ownerAgentId: managerId,
        previousOwnerAgentId: coderId,
      });
      // The dashboard invariant: a real escalation cites the real failure, never
      // the checkout-handover marker.
      expect(action?.evidence).toMatchObject({ latestRunErrorCode: "run_crashed" });
      const [escalated] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      expect(escalated).toMatchObject({ status: "blocked", assigneeAgentId: managerId });
      // The transfer is legible in the issue history, not only in
      // `activeRecoveryAction`: the comment names the action, the cause, and who
      // the issue was taken from.
      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, sourceIssueId));
      const escalationComment = comments.find((row) =>
        (row.body ?? "").includes(`Reassigned by recovery action \`${action!.id}\``),
      );
      expect(escalationComment?.body).toContain("cause `stranded_assigned_issue`");
      expect(escalationComment?.body).toContain(`to owner \`${managerId}\``);
    });
  });
});
