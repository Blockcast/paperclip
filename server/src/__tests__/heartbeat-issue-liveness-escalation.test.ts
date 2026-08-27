import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueTreeHolds,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged liveness escalation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

/**
 * Test-controlled seam for the one interleaving the stale-escalation sweep cannot
 * reproduce with fixture state alone: a checkout that lands AFTER the sweep's ownership
 * guard has committed and BEFORE its cancel. The guard is the only boundary in that
 * window, so the hook fires immediately after the real implementation returns.
 *
 * Default is null and the wrapper is a pass-through, so every other test in this file
 * exercises the unmodified service.
 */
const guardBoundary = vi.hoisted(() => ({
  afterExecutionLockGuard: null as null | ((issueId: string) => Promise<void>),
}));

vi.mock("../services/issues.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/issues.ts")>("../services/issues.ts");
  return {
    ...actual,
    issueService: (db: Parameters<typeof actual.issueService>[0]) => {
      const svc = actual.issueService(db);
      return {
        ...svc,
        releaseExecutionLockIfOwnerReapable: async (id: string) => {
          const outcome = await svc.releaseExecutionLockIfOwnerReapable(id);
          await guardBoundary.afterExecutionLockGuard?.(id);
          return outcome;
        },
      };
    },
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { issueService } from "../services/issues.ts";
import { runningProcesses } from "../adapters/index.ts";
import {
  ABANDONED_LIVENESS_RECOVERY_MARKER,
  DEFAULT_LIVENESS_ABANDONED_RECOVERY_MS,
  DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS,
  DEFAULT_LIVENESS_UNCHANGED_TARGET_SUPPRESSION_MS,
  STALE_LIVENESS_ESCALATION_AUTO_RESOLVE_MARKER,
} from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue liveness escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat issue graph liveness escalation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let heartbeatSvc: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-liveness-");
    db = createDb(tempDb.connectionString);
    heartbeatSvc = heartbeatService(db);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    guardBoundary.afterExecutionLockGuard = null;
    runningProcesses.clear();
    await cleanupHeartbeatTestState(db, heartbeatSvc, {
      errorLabel: "heartbeat issue liveness escalation test cleanup",
    });
    await instanceSettingsService(db).updateExperimental({
      enableIssueGraphLivenessAutoRecovery: false,
      enableIsolatedWorkspaces: false,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function enableAutoRecovery() {
    await instanceSettingsService(db).updateExperimental({
      enableIssueGraphLivenessAutoRecovery: true,
    });
  }

  async function seedBlockedChain(
    opts: {
      notYetStale?: boolean;
      // Override the blocker leaf's status (default "todo"). The
      // "assigned backlog blocker leaf" scenario passes "backlog".
      blockerStatus?: "backlog" | "todo" | "in_progress" | "blocked" | "in_review";
      // Symbolic agent reference for the blocker's assignee — "coder",
      // "manager", or undefined (unassigned). The escalation engine
      // distinguishes assigned-vs-unassigned blockers when deciding the
      // recovery owner and origin fingerprint.
      blockerAssigneeAgentId?: "coder" | "manager" | null;
    } = {},
  ) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);

    // Post-2026-05-06 RCA the gate is INVERTED: findings escalate when
    // the recoveryIssue has been silently quiet for at least the
    // staleness threshold. `notYetStale: true` means "just touched --
    // operator may still be acting", which the gate skips.
    const issueTimestamp = opts.notYetStale === true
      ? new Date(Date.now() - 60 * 60 * 1000)
      : new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked parent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
        lastActivityAt: issueTimestamp,
      },
      {
        id: blockerIssueId,
        companyId,
        title: "Missing unblock owner",
        status: opts.blockerStatus ?? "todo",
        priority: "medium",
        assigneeAgentId:
          opts.blockerAssigneeAgentId === "coder"
            ? coderId
            : opts.blockerAssigneeAgentId === "manager"
              ? managerId
              : null,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
        lastActivityAt: issueTimestamp,
      },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    return { companyId, managerId, coderId, blockedIssueId, blockerIssueId };
  }

  /**
   * The prior-escalation fixture, in one place (BLO-27676 review).
   *
   * Several tests here need "an escalation for this incident that has already
   * been closed", differing only in status and two timestamps. Inlining the
   * ~16-field row once per test had already cost two rounds of correcting the
   * same fixture detail across a subset of the copies; one shape means the next
   * such correction is one edit, and each caller shows only the timestamps that
   * are actually its subject.
   *
   * `parentId` is the LEAF blocker because production parents these rows there
   * (asserted by "creates one manager escalation, preserves blockers, and
   * records owner selection"). It is NOT in the suppressor's lookup predicate,
   * so it changes nothing about what these tests prove -- it keeps the fixture
   * the same shape as the rows the code under test actually produces.
   */
  async function seedResolvedEscalation(input: {
    companyId: string;
    managerId: string;
    blockerIssueId: string;
    incidentKey: string;
    /** The timestamp the suppressor compares: `coalesce(completedAt, updatedAt)`. */
    resolvedAt: Date;
    /** Default "done". "cancelled" re-arms immediately, by design. */
    status?: "done" | "cancelled";
    /**
     * Defaults to `resolvedAt`. Pass `null` to pin the `coalesce` fallback (a
     * row closed without a `completedAt`); pass `updatedAt` separately to model
     * a post-close edit that bumps it above the resolution.
     */
    completedAt?: Date | null;
    updatedAt?: Date;
    /**
     * When set, backdate the leaf blocker's activity to this instant.
     *
     * Timing here is easy to get wrong: the escalation gate ALSO requires the
     * leaf to have been quiet for the staleness threshold, so "touch the leaf"
     * cannot mean "touch it just now" -- that suppresses the finding through a
     * different gate and the test proves nothing. A touch meant to re-arm this
     * suppressor must fall after `resolvedAt` and still >=24h before `now`.
     */
    leafQuietSince?: Date;
    title?: string;
    identifier?: string;
    issueNumber?: number;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      title: input.title ?? "Closed escalation",
      status: input.status ?? "done",
      priority: "high",
      parentId: input.blockerIssueId,
      assigneeAgentId: input.managerId,
      issueNumber: input.issueNumber ?? 3,
      identifier: input.identifier ?? "CLOSED-3",
      originKind: "harness_liveness_escalation",
      originId: input.incidentKey,
      createdAt: new Date(input.resolvedAt.getTime() - 30 * 60 * 1000),
      updatedAt: input.updatedAt ?? input.resolvedAt,
      completedAt: input.completedAt === undefined ? input.resolvedAt : input.completedAt,
    });
    if (input.leafQuietSince) {
      // Backdate `createdAt` with the activity, so the leaf does not end up with
      // `updatedAt` earlier than `createdAt` -- an ordering no real row can have,
      // and one that `issueCreatedAtGte` (always injected via heartbeat.ts) could
      // start tripping over for reasons unrelated to this behaviour.
      await db
        .update(issues)
        .set({
          lastActivityAt: input.leafQuietSince,
          updatedAt: input.leafQuietSince,
          createdAt: new Date(input.leafQuietSince.getTime() - 60 * 60 * 1000),
        })
        .where(eq(issues.id, input.blockerIssueId));
    }
    return id;
  }

  /** The `blocked_by_*` incident key the detector builds for a seeded chain. */
  function livenessIncidentKey(
    companyId: string,
    blockedIssueId: string,
    blockerIssueId: string,
    state = "blocked_by_unassigned_issue",
  ) {
    return ["harness_liveness", companyId, blockedIssueId, state, blockerIssueId].join(":");
  }

  async function seedResolvedDependencyBackstopFixture(opts: {
    workspaceState?: "none" | "not_finalized" | "finalized";
    assignee?: "agent" | null;
  } = {}) {
    const workspaceState = opts.workspaceState ?? "none";
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Priya",
      role: "engineer",
      status: "idle",
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    if (workspaceState !== "none") {
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Synthetic dependency project",
        status: "in_progress",
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Synthetic workspace",
        sourceType: "git_worktree",
      });
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Synthetic execution workspace",
        providerType: "git_worktree",
      });
    }

    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic blocked dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: opts.assignee === null ? null : agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockerIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic completed blocker",
        status: "done",
        priority: "medium",
        executionWorkspaceId: workspaceState === "none" ? null : executionWorkspaceId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    if (workspaceState === "not_finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "adapter_execute",
        status: "succeeded",
        startedAt: new Date(Date.now() - 60_000),
      });
    } else if (workspaceState === "finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date(),
      });
    }

    return { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId };
  }

  it("keeps liveness findings advisory when auto recovery is disabled", async () => {
    await instanceSettingsService(db).updateExperimental({
      enableIssueGraphLivenessAutoRecovery: false,
    });
    const { companyId } = await seedBlockedChain();
    const heartbeat = heartbeatSvc;

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.autoRecoveryEnabled).toBe(false);
    expect(result.escalationsCreated).toBe(0);
    expect(result.skippedAutoRecoveryDisabled).toBe(1);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("keeps resolved dependency wake reconciliation active when liveness auto recovery is disabled", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    expect(result.autoRecoveryEnabled).toBe(false);
    expect(result.dependencyWakesHealed).toBe(1);
    expect(result.dependencyWakeIssueIds).toEqual([blockedIssueId]);
    expect(result.escalationsCreated).toBe(0);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(`issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`);
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityId: blockedIssueId,
      details: expect.objectContaining({ source: "issue_graph_liveness.backstop" }),
    });
  });

  it("heals a blocked dependent whose done blocker has no workspace finalize obligation", async () => {
    await enableAutoRecovery();
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(0);
    expect(result.dependencyWakesHealed).toBe(1);
    expect(result.dependencyWakeIssueIds).toEqual([blockedIssueId]);
    expect(result.escalationsCreated).toBe(0);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(`issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`);
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityId: blockedIssueId });
  });

  it("reconciles a resolved blocked dependency after the assignee-null window closes", async () => {
    const { agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none", assignee: null });
    const heartbeat = heartbeatSvc;

    const beforeAssignment = await heartbeat.reconcileIssueGraphLiveness();

    expect(beforeAssignment.dependencyWakesHealed).toBe(0);
    expect(beforeAssignment.dependencyWakeBackstopChecked).toBe(0);

    await db
      .update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, blockedIssueId));

    const afterAssignment = await heartbeat.reconcileIssueGraphLiveness();

    expect(afterAssignment.dependencyWakesHealed).toBe(1);
    expect(afterAssignment.dependencyWakeIssueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`,
    });
  });

  it("retries a resolved dependency wake when the prior wake was skipped as stale", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const idempotencyKey = `issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`;
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "skipped",
      finishedAt: new Date(),
      error: "Cancelled because issue assignee changed before the queued run could start",
      idempotencyKey,
    });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    expect(result.dependencyWakesHealed).toBe(1);
    expect(result.dependencyWakeExistingSkipped).toBe(0);

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")))
      .orderBy(agentWakeupRequests.requestedAt);

    expect(wakes).toHaveLength(2);
    expect(wakes.map((wake) => wake.status)).toContain("skipped");
    expect(wakes.every((wake) => wake.idempotencyKey === idempotencyKey)).toBe(true);
    expect(wakes.some((wake) => ["queued", "claimed", "completed"].includes(wake.status))).toBe(true);
  });

  it("waits for workspace finalize before healing a resolved blocked dependent", async () => {
    await enableAutoRecovery();
    const { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "not_finalized" });
    const heartbeat = heartbeatSvc;

    const beforeFinalize = await heartbeat.reconcileIssueGraphLiveness();

    expect(beforeFinalize.findings).toBe(0);
    expect(beforeFinalize.dependencyWakesHealed).toBe(0);
    expect(beforeFinalize.dependencyWakeNotReadySkipped).toBe(1);

    const wakesBeforeFinalize = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakesBeforeFinalize).toHaveLength(0);

    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: blockerIssueId,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date(),
    });

    const afterFinalize = await heartbeat.reconcileIssueGraphLiveness();

    expect(afterFinalize.dependencyWakesHealed).toBe(1);
    expect(afterFinalize.dependencyWakeIssueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`,
    });
  });

  it("does not duplicate an existing dependency wake keyed to any resolved blocker", async () => {
    await enableAutoRecovery();
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const secondBlockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondBlockerIssueId,
      companyId,
      title: "Second completed blocker",
      status: "done",
      priority: "medium",
      issueNumber: 3,
      identifier: "R-MULTI-3",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: secondBlockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const readiness = await issueService(db).getDependencyReadiness(blockedIssueId);
    const blockerIdNotUsedByBackstop = readiness.blockerIssueIds.find((id) => id !== blockerIssueId);
    if (!blockerIdNotUsedByBackstop) {
      throw new Error("Expected a second blocker id in dependency readiness");
    }
    expect(blockerIdNotUsedByBackstop).toBe(secondBlockerIssueId);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIdNotUsedByBackstop,
      },
      status: "queued",
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${blockerIdNotUsedByBackstop}`,
    });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    expect(result.dependencyWakesHealed).toBe(0);
    expect(result.dependencyWakeExistingSkipped).toBe(1);

    const wakes = await db
      .select({
        id: agentWakeupRequests.id,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.idempotencyKey).toBe(
      `issue_blockers_resolved:${blockedIssueId}:${blockerIdNotUsedByBackstop}`,
    );
  });

  it("counts null dependency wake returns as deferred instead of enqueue failures", async () => {
    await enableAutoRecovery();
    const { companyId, agentId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    await db
      .update(agents)
      .set({
        runtimeConfig: { heartbeat: { wakeOnDemand: false, maxConcurrentRuns: 1 } },
      })
      .where(eq(agents.id, agentId));

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    expect(result.dependencyWakesHealed).toBe(0);
    expect(result.dependencyWakeDeferredOrFailed).toBe(1);
    expect(result.dependencyWakeEnqueueFailed).toBe(0);

    const skippedWake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)))
      .then((rows) => rows[0] ?? null);
    expect(skippedWake).toMatchObject({
      status: "skipped",
      reason: "heartbeat.wakeOnDemand.disabled",
    });
  });

  it("does not create recovery issues outside the configured lookback window", async () => {
    await enableAutoRecovery();
    const { companyId } = await seedBlockedChain({ notYetStale: true });
    const heartbeat = heartbeatSvc;

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(0);
    // Field name preserved for back-compat with existing telemetry.
    expect(result.skippedOutsideLookback).toBe(1);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("suppresses liveness escalation when the source issue is under an active pause hold", async () => {
    await enableAutoRecovery();
    const { companyId, blockedIssueId } = await seedBlockedChain();

    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: blockedIssueId,
      mode: "pause",
      status: "active",
      reason: "pause liveness recovery subtree",
      releasePolicy: { strategy: "manual" },
    });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.escalationsCreated).toBe(0);
    expect(result.existingEscalations).toBe(0);
    expect(result.skipped).toBe(1);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(0);
  });

  it("treats an active executionRunId on the leaf blocker as a live execution path", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      status: "running",
      contextSnapshot: { issueId: blockedIssueId },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, blockerIssueId));
    const heartbeat = heartbeatSvc;

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(0);
    expect(result.escalationsCreated).toBe(0);
  });

  it("creates one bounded escalation for an assigned backlog blocker leaf", async () => {
    await enableAutoRecovery();
    const { companyId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain({
      blockerStatus: "backlog",
      blockerAssigneeAgentId: "coder",
    });
    const heartbeat = heartbeatSvc;

    const first = await heartbeat.reconcileIssueGraphLiveness();
    const second = await heartbeat.reconcileIssueGraphLiveness();

    expect(first.findings).toBe(1);
    expect(first.escalationsCreated).toBe(1);
    expect(second.findings).toBe(0);
    expect(second.escalationsCreated).toBe(0);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      assigneeAgentId: coderId,
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "blocked_by_assigned_backlog_issue",
        blockerIssueId,
      ].join(":"),
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_assigned_backlog_issue",
        blockerIssueId,
      ].join(":"),
    });
  });

  it("treats open recovery issues as active waiting paths for non-assigned-backlog states", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const existingEscalationId = randomUUID();

    await db.insert(issues).values({
      id: existingEscalationId,
      companyId,
      title: "Existing liveness unblock work",
      status: "todo",
      priority: "high",
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      issueNumber: 5,
      identifier: `${`P${companyId.replace(/-/g, "").slice(0, 4)}`}-5`,
      originKind: "harness_liveness_escalation",
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "in_review_without_action_path",
        blockerIssueId,
      ].join(":"),
    });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(0);
    expect(result.escalationsCreated).toBe(0);
    expect(result.existingEscalations).toBe(0);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
  });

  it("keeps active invalid_review_participant recoveries from being retired", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const existingEscalationId = randomUUID();

    await db.insert(issues).values({
      id: existingEscalationId,
      companyId,
      title: "Existing invalid review participant unblock work",
      status: "todo",
      priority: "high",
      parentId: blockedIssueId,
      assigneeAgentId: managerId,
      issueNumber: 5,
      identifier: `${`P${companyId.replace(/-/g, "").slice(0, 4)}`}-5`,
      originKind: "harness_liveness_escalation",
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "invalid_review_participant",
        blockerIssueId,
      ].join(":"),
    });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(0);
    expect(result.escalationsCreated).toBe(0);
    expect(result.existingEscalations).toBe(0);

    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
  });

  it("creates one manager escalation without blocking its own source, and records owner selection", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatSvc;

    const first = await heartbeat.reconcileIssueGraphLiveness();
    const second = await heartbeat.reconcileIssueGraphLiveness();

    expect(first.escalationsCreated).toBe(1);
    expect(second.escalationsCreated).toBe(0);

    const escalations = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "harness_liveness_escalation"),
        ),
      );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      status: expect.stringMatching(/^(todo|in_progress|done)$/),
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_unassigned_issue",
        blockerIssueId,
      ].join(":"),
    });

    // BLO-28618: the escalation must NOT appear in its own source's blocker
    // set. Writing that edge wedged the source behind a fabricated dependency
    // nobody works, and closing the row later dropped the source into a
    // detector-triggering state -- the re-file loop. The real blocker is the
    // only edge that survives.
    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.map((row) => row.blockerIssueId)).toEqual([blockerIssueId]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("harness-level liveness incident");
    expect(comments[0]?.body).toContain(escalations[0]?.identifier ?? escalations[0]!.id);

    const events = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const createdEvent = events.find((event) => event.action === "issue.harness_liveness_escalation_created");
    expect(createdEvent).toBeTruthy();
    expect(createdEvent?.details).toMatchObject({
      recoveryIssueId: blockerIssueId,
      ownerSelection: {
        selectedAgentId: managerId,
        selectedReason: "root_agent",
        selectedSourceIssueId: blockerIssueId,
      },
      workspaceSelection: {
        reuseRecoveryExecutionWorkspace: false,
        inheritedExecutionWorkspaceFromIssueId: null,
        projectWorkspaceSourceIssueId: blockerIssueId,
      },
    });
    expect(events.some((event) => event.action === "issue.blockers.updated")).toBe(false);

    // The source keeps its own status too -- it is not force-flipped to
    // `blocked`, which is what left sources at `blocked` with an empty blocker
    // set once the recovery row was closed.
    const [sourceAfter] = await db.select().from(issues).where(eq(issues.id, blockedIssueId));
    expect(sourceAfter?.status).toBe("blocked");
    const [leafAfter] = await db.select().from(issues).where(eq(issues.id, blockerIssueId));
    expect(leafAfter?.status).toBe("todo");
  });

  /**
   * BLO-29601: an escalation is minted from a premise and then never re-checked, so when
   * the premise clears the row stays open and keeps costing an agent run to rediscover
   * that there is nothing to do.
   *
   * All three tests below mint a REAL escalation through `reconcileIssueGraphLiveness`
   * rather than hand-inserting one, because the defect lives in the interaction between
   * the row's `originId` and the classifier — a fixture with a hand-written key would
   * not exercise the parse, the blocker wiring, or the self-satisfying waiting path that
   * makes the re-check hard in the first place.
   */
  async function mintEscalation() {
    await enableAutoRecovery();
    const seeded = await seedBlockedChain();
    const created = await heartbeatSvc.reconcileIssueGraphLiveness();
    expect(created.escalationsCreated).toBe(1);
    const escalation = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, seeded.companyId),
          eq(issues.originKind, "harness_liveness_escalation"),
        ),
      )
      .then((rows) => rows[0]!);
    expect(escalation.originId).toContain("blocked_by_unassigned_issue");
    return { ...seeded, escalation };
  }

  it("auto-closes a liveness escalation once its originating invariant stops holding", async () => {
    const { blockedIssueId, blockerIssueId, escalation } = await mintEscalation();

    // Clear the premise the escalation was minted from: the unassigned blocker leaf is
    // resolved, so `blocked_by_unassigned_issue` has nothing left to fire against.
    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, blockerIssueId));

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    expect(result.staleEscalationsAutoResolved).toBe(1);
    expect(result.staleEscalationsPremiseStillTrueSkipped).toBe(0);
    expect(result.staleEscalationAutoResolvedIssueIds).toEqual([escalation.id]);
    // The cancel now removes the blocker edge in its own transaction, ahead of the
    // residual `removeRecoveryBlockerFromSource`. The counter has to keep reporting the
    // unwiring rather than silently dropping to zero because the residual path found
    // nothing left to do.
    expect(result.staleEscalationBlockerRelationsRemoved).toBe(1);

    const closed = await db
      .select()
      .from(issues)
      .where(eq(issues.id, escalation.id))
      .then((rows) => rows[0]!);
    expect(closed.status).toBe("cancelled");

    // The comment must name the invariant, so a human reading the closed row can tell
    // WHY it went away rather than finding a silently-cancelled escalation.
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, escalation.id));
    const autoResolve = comments.find((comment) =>
      comment.body.includes(STALE_LIVENESS_ESCALATION_AUTO_RESOLVE_MARKER),
    );
    expect(autoResolve).toBeTruthy();
    expect(autoResolve?.body).toContain("blocked_by_unassigned_issue");
    expect(autoResolve?.body).toContain(escalation.originId!);

    // The blocker edge comes off the source first. Cancelling while still wired would
    // leave the source blocked behind a cancelled issue — a fresh liveness violation.
    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.map((row) => row.blockerIssueId)).not.toContain(escalation.id);
  });

  it("releases the execution run held by a stale escalation instead of stranding it", async () => {
    const { companyId, managerId, blockerIssueId, escalation } = await mintEscalation();

    // A NEVER-STARTED run (`queued`, null startedAt) holding the escalation. This is the
    // branch `retireObsoleteLivenessRecoveryIssues` refuses to touch
    // (`hasActiveRunForIssueId` -> activeSkipped), and terminal status alone does NOT clear
    // these columns, so without an explicit release the lock outlives the premise. Such a
    // run holds no real claim, so releasing it is safe — contrast the `running` owner
    // covered above, which is refused.
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      status: "queued",
      contextSnapshot: { issueId: escalation.id },
    });
    await db
      .update(issues)
      .set({
        executionRunId: runId,
        checkoutRunId: runId,
        executionAgentNameKey: "cto",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, escalation.id));

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerIssueId));

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    expect(result.staleEscalationsAutoResolved).toBe(1);
    expect(result.staleEscalationRunsReleased).toBe(1);

    const closed = await db
      .select()
      .from(issues)
      .where(eq(issues.id, escalation.id))
      .then((rows) => rows[0]!);
    expect(closed.status).toBe("cancelled");
    expect(closed.executionRunId).toBeNull();
    expect(closed.checkoutRunId).toBeNull();
    expect(closed.executionLockedAt).toBeNull();
  });

  /**
   * The other branch a happy-path suite would miss, and the inverse of the one above.
   *
   * `queued` is a never-started owner: it holds no real claim, so releasing its lock is
   * safe. A `running` owner with a non-null `startedAt` is a live worker. Detaching its
   * lock and then cancelling the issue underneath it leaves that worker writing to a row
   * it no longer owns — and the release primitive it would go through, `adminForceRelease`,
   * clears both lock columns unconditionally while its follow-up cleanup cancels only
   * never-started runs. So the live worker survives the release, which is precisely the
   * combination that must never happen here.
   *
   * The premise IS false in this test. Auto-resolution is still refused, because "the
   * premise is dead" does not license yanking a lock out from under a running process —
   * the row is simply left for a later tick, once the run reaches a terminal status.
   */
  it("leaves a stale escalation untouched while a running owner still holds its lock", async () => {
    const { companyId, managerId, blockedIssueId, blockerIssueId, escalation } =
      await mintEscalation();

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId: escalation.id },
    });
    await db
      .update(issues)
      .set({
        executionRunId: runId,
        checkoutRunId: runId,
        executionAgentNameKey: "cto",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, escalation.id));

    // Kill the premise, so the ONLY thing standing between this row and auto-resolution
    // is the running owner.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerIssueId));

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    expect(result.staleEscalationsLiveRunSkipped).toBe(1);
    expect(result.staleEscalationsAutoResolved).toBe(0);
    expect(result.staleEscalationRunsReleased).toBe(0);
    expect(result.staleEscalationAutoResolvedIssueIds).toEqual([]);

    const untouched = await db
      .select()
      .from(issues)
      .where(eq(issues.id, escalation.id))
      .then((rows) => rows[0]!);
    expect(untouched.status).not.toBe("cancelled");
    // The lock is intact: the running worker still owns the row it is writing to.
    expect(untouched.executionRunId).toBe(runId);
    expect(untouched.checkoutRunId).toBe(runId);
    expect(untouched.executionLockedAt).not.toBeNull();

    // The run itself was not cancelled out from under the worker.
    const ownerRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);
    expect(ownerRun.status).toBe("running");

    // Nothing was half-done: no auto-resolve comment, and the real blocker relation remains
    // the only edge. Current master deliberately does not fabricate an escalation edge.
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, escalation.id));
    expect(
      comments.some((comment) =>
        comment.body.includes(STALE_LIVENESS_ESCALATION_AUTO_RESOLVE_MARKER),
      ),
    ).toBe(false);
    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.map((row) => row.blockerIssueId)).toEqual([blockerIssueId]);
  });

  /**
   * The interleaving the two tests above cannot reach, and the one the ownership guard
   * alone does not cover.
   *
   * Both of those start with the lock ALREADY attached, so the guard sees an owner and
   * decides on state it read itself. This one starts unlocked: the guard returns
   * `no_lock`, declines to skip, and commits — and only then does an agent check the row
   * out, exactly as a dispatch landing a millisecond later would. Everything the guard
   * concluded is stale by the time the sweep acts on it.
   *
   * The cancel is what has to catch this, by pinning the lock columns the guard left
   * behind as a write precondition. If it instead cancels unconditionally, a live worker
   * is left attached to a cancelled issue that has been unwired from its subject.
   */
  it("leaves a stale escalation intact when an agent checks it out inside the guard window", async () => {
    const { companyId, managerId, blockedIssueId, blockerIssueId, escalation } =
      await mintEscalation();

    // Precondition that makes this test distinct: no owner at all going in.
    expect(escalation.executionRunId).toBeNull();
    expect(escalation.checkoutRunId).toBeNull();

    // Kill the premise, so the ONLY thing standing between this row and auto-resolution
    // is the checkout that lands mid-window.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerIssueId));

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId: escalation.id },
    });

    // A real checkout through the public path, not a hand-written lock column update, so
    // this asserts against the same CAS an actual dispatch would race through.
    let checkouts = 0;
    guardBoundary.afterExecutionLockGuard = async (issueId) => {
      if (issueId !== escalation.id || checkouts > 0) return;
      checkouts += 1;
      await issueService(db).checkout(escalation.id, managerId, [escalation.status], runId);
    };

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    // The window was genuinely exercised — otherwise the assertions below prove nothing.
    expect(checkouts).toBe(1);
    expect(result.staleEscalationsAutoResolved).toBe(0);
    expect(result.staleEscalationsLiveRunSkipped).toBe(1);
    expect(result.staleEscalationAutoResolvedIssueIds).toEqual([]);

    const untouched = await db
      .select()
      .from(issues)
      .where(eq(issues.id, escalation.id))
      .then((rows) => rows[0]!);
    expect(untouched.status).not.toBe("cancelled");
    // The lock the checkout took is intact: the sweep did not cancel out from under it.
    expect(untouched.executionRunId).toBe(runId);
    expect(untouched.checkoutRunId).toBe(runId);

    // The run the checkout attached is still live.
    const ownerRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);
    expect(ownerRun.status).toBe("running");

    // Nothing was half-done: no auto-resolve comment, and the real blocker relation remains
    // the only edge. Current master deliberately does not fabricate an escalation edge.
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, escalation.id));
    expect(
      comments.some((comment) =>
        comment.body.includes(STALE_LIVENESS_ESCALATION_AUTO_RESOLVE_MARKER),
      ),
    ).toBe(false);
    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.map((row) => row.blockerIssueId)).toEqual([blockerIssueId]);
  });

  /**
   * The branch that must not regress, and the one a happy-path-only suite would miss.
   *
   * An open escalation contributes a waiting path for its OWN subject issue
   * (`hasExplicitWaitingPath` -> `openRecoveryIssues`), so the naive re-check — "re-run
   * the classifier and see whether the invariant still fires" — reports "premise
   * cleared" for every escalation, live ones included, and closes the whole backlog
   * while the incidents are still real. The re-check has to exclude escalation-supplied
   * waiting paths before it can answer the question at all.
   */
  it("leaves a liveness escalation open while its originating invariant still holds", async () => {
    const { escalation } = await mintEscalation();

    // Nothing about the graph changes: the blocker leaf is still todo and unassigned.
    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    expect(result.staleEscalationsAutoResolved).toBe(0);
    expect(result.staleEscalationsPremiseStillTrueSkipped).toBe(1);
    expect(result.staleEscalationRunsReleased).toBe(0);

    const stillOpen = await db
      .select()
      .from(issues)
      .where(eq(issues.id, escalation.id))
      .then((rows) => rows[0]!);
    expect(stillOpen.status).not.toBe("cancelled");
    expect(stillOpen.status).not.toBe("done");

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, escalation.id));
    expect(
      comments.some((comment) =>
        comment.body.includes(STALE_LIVENESS_ESCALATION_AUTO_RESOLVE_MARKER),
      ),
    ).toBe(false);
  });

  // Pre-BLO-28618 this asserted the *cycle rejection* fallback: the detector
  // tried to add the escalation as a blocker of its source, hit the cycle
  // guard, and fell back to persisting the pre-existing blocker set. The
  // detector no longer writes that edge at all, so there is no cycle to
  // reject. Kept as the stronger invariant: with an escalation already open
  // and the reverse edge already present, reconciliation leaves both the
  // source's blocker set and its status exactly as it found them.
  it("never writes the escalation into its own source's blocker set", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain({
      blockerStatus: "backlog",
      blockerAssigneeAgentId: "coder",
    });
    const escalationIssueId = randomUUID();
    await db.insert(issues).values({
      id: escalationIssueId,
      companyId,
      title: "Existing liveness unblock work",
      status: "todo",
      priority: "high",
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      issueNumber: 5,
      identifier: `P${companyId.replace(/-/g, "").slice(0, 4)}-5`,
      originKind: "harness_liveness_escalation",
      originId: "malformed-legacy-incident-key",
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_assigned_backlog_issue",
        blockerIssueId,
      ].join(":"),
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockedIssueId,
      relatedIssueId: escalationIssueId,
      type: "blocks",
    });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.existingEscalations).toBe(1);
    const persistedBlockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(persistedBlockers.map((row) => row.blockerIssueId)).toEqual([blockerIssueId]);
    const reverseEdge = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, escalationIssueId));
    expect(reverseEdge.map((row) => row.blockerIssueId)).toEqual([blockedIssueId]);
    const blockerEvent = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "issue.blockers.updated"),
        eq(activityLog.entityId, blockedIssueId),
      ))
      .then((rows) => rows.at(-1));
    expect(blockerEvent).toBeUndefined();

    const [sourceAfter] = await db.select().from(issues).where(eq(issues.id, blockedIssueId));
    expect(sourceAfter?.status).toBe("blocked");
  });

  it("writes no reverse edge when the source already blocks its open escalation", async () => {
    await enableAutoRecovery();
    const companyId = randomUUID();
    const managerId = randomUUID();
    const issueId = randomUUID();
    const escalationIssueId = randomUUID();
    const issuePrefix = `Z${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });

    // Source issue is in_review with no assignee and no pre-existing blockers
    // of its own -- the self-referential "in_review_without_action_path"
    // finding treats the issue as both the source and its own recovery issue.
    // Before BLO-28618 this shape reached the cycle fallback in
    // `ensureIssueBlockedByEscalation` with an empty blockerIds set; that
    // function is gone and no edge is written at all now, so the case is kept
    // as the stronger invariant -- see the reverse-edge setup below.
    const issueTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stuck in review with no owner",
      status: "in_review",
      priority: "medium",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      createdAt: issueTimestamp,
      updatedAt: issueTimestamp,
      lastActivityAt: issueTimestamp,
    });

    // An already-open escalation for this leaf, discovered via fingerprint
    // (a malformed originId keeps it out of the openRecoveryIssues waiting-path
    // set, mirroring the legacy-key regression above) so the review finding
    // still fires instead of being suppressed.
    await db.insert(issues).values({
      id: escalationIssueId,
      companyId,
      title: "Existing liveness unblock work",
      status: "todo",
      priority: "high",
      parentId: issueId,
      assigneeAgentId: managerId,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
      originKind: "harness_liveness_escalation",
      originId: "malformed-legacy-incident-key",
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "in_review_without_action_path",
        issueId,
      ].join(":"),
    });
    // The source issue already blocks the escalation issue (e.g. left over from
    // an earlier partial recovery). Under the old code, adding the reverse edge
    // -- escalation blocks source -- would have formed a 2-cycle and taken the
    // cycle fallback. BLO-28618 removed the reverse-edge write entirely, so the
    // assertions below are now the stronger claim: no edge is added, this
    // pre-existing edge is left alone, and the source's status is untouched.
    // `persistedBlockers` staying empty is what would catch a reintroduced
    // self-blocker edge.
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: escalationIssueId,
      type: "blocks",
    });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(1);
    expect(result.existingEscalations).toBe(1);

    const [sourceAfter] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceAfter?.status).toBe("in_review");

    const persistedBlockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, issueId));
    expect(persistedBlockers).toHaveLength(0);

    const preservedEdge = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, escalationIssueId));
    expect(preservedEdge.map((row) => row.blockerIssueId)).toEqual([issueId]);

    const blockerEvent = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "issue.blockers.updated"),
        eq(activityLog.entityId, issueId),
      ))
      .then((rows) => rows.at(-1));
    expect(blockerEvent).toBeUndefined();
  });

  it("skips budget-blocked direct owners and assigns recovery to the manager fallback", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, coderId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const issueTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db
      .update(issues)
      .set({
        status: "in_review",
        assigneeAgentId: coderId,
        updatedAt: issueTimestamp,
        lastActivityAt: issueTimestamp,
      })
      .where(eq(issues.id, blockerIssueId));
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: coderId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      hardStopEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId,
      agentId: coderId,
      issueId: blockerIssueId,
      provider: "test",
      biller: "test",
      billingType: "tokens",
      model: "test-model",
      costCents: 1,
      occurredAt: new Date(),
    });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    expect(result.escalationsCreated).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "in_review_without_action_path",
        blockerIssueId,
      ].join(":"),
    });

    const events = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const createdEvent = events.find((event) => event.action === "issue.harness_liveness_escalation_created");
    expect(createdEvent?.details).toMatchObject({
      ownerSelection: {
        selectedAgentId: managerId,
        selectedReason: "assignee_reporting_chain",
        budgetBlockedCandidateAgentIds: [coderId],
      },
    });
  });

  it("parents recovery under the leaf blocker without inheriting dependent or blocker execution state for manager-owned recovery", async () => {
    await enableAutoRecovery();
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    const companyId = randomUUID();
    const managerId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const dependentProjectId = randomUUID();
    const blockerProjectId = randomUUID();
    const dependentProjectWorkspaceId = randomUUID();
    const blockerProjectWorkspaceId = randomUUID();
    const dependentExecutionWorkspaceId = randomUUID();
    const blockerExecutionWorkspaceId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    // 25h ago — past the default 24h staleness threshold (post-2026-05-06 RCA gate inversion).
    const issueTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Root Operator",
      role: "operator",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false } },
      permissions: {},
    });
    await db.insert(projects).values([
      {
        id: dependentProjectId,
        companyId,
        name: "Dependent workspace project",
        status: "in_progress",
      },
      {
        id: blockerProjectId,
        companyId,
        name: "Blocker workspace project",
        status: "in_progress",
      },
    ]);
    await db.insert(projectWorkspaces).values([
      {
        id: dependentProjectWorkspaceId,
        companyId,
        projectId: dependentProjectId,
        name: "Dependent primary",
      },
      {
        id: blockerProjectWorkspaceId,
        companyId,
        projectId: blockerProjectId,
        name: "Blocker primary",
      },
    ]);
    await db.insert(executionWorkspaces).values([
      {
        id: dependentExecutionWorkspaceId,
        companyId,
        projectId: dependentProjectId,
        projectWorkspaceId: dependentProjectWorkspaceId,
        mode: "operator_branch",
        strategyType: "git_worktree",
        name: "Dependent branch",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: blockerExecutionWorkspaceId,
        companyId,
        projectId: blockerProjectId,
        projectWorkspaceId: blockerProjectWorkspaceId,
        mode: "operator_branch",
        strategyType: "git_worktree",
        name: "Blocker branch",
        status: "active",
        providerType: "git_worktree",
      },
    ]);
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        projectId: dependentProjectId,
        projectWorkspaceId: dependentProjectWorkspaceId,
        executionWorkspaceId: dependentExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "operator_branch" },
        title: "Blocked dependent",
        status: "blocked",
        priority: "medium",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
        lastActivityAt: issueTimestamp,
      },
      {
        id: blockerIssueId,
        companyId,
        projectId: blockerProjectId,
        projectWorkspaceId: blockerProjectWorkspaceId,
        executionWorkspaceId: blockerExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "operator_branch" },
        title: "Unassigned leaf blocker",
        status: "todo",
        priority: "medium",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
        lastActivityAt: issueTimestamp,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    expect(result.escalationsCreated).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      parentId: blockerIssueId,
      projectId: blockerProjectId,
      projectWorkspaceId: blockerProjectWorkspaceId,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      assigneeAgentId: managerId,
    });
  });

  it("reuses one open recovery issue for multiple dependents with the same leaf blocker", async () => {
    await enableAutoRecovery();
    const { companyId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const secondBlockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const issueTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db.insert(issues).values({
      id: secondBlockedIssueId,
      companyId,
      title: "Second blocked parent",
      status: "blocked",
      priority: "medium",
      issueNumber: 3,
      identifier: `${issuePrefix}-3`,
      createdAt: issueTimestamp,
      updatedAt: issueTimestamp,
      lastActivityAt: issueTimestamp,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: secondBlockedIssueId,
      type: "blocks",
    });
    const heartbeat = heartbeatSvc;

    const result = await heartbeat.reconcileIssueGraphLiveness();

    expect(result.findings).toBe(2);
    expect(result.escalationsCreated).toBe(1);
    expect(result.existingEscalations).toBe(1);
    const escalations = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));
    expect(escalations).toHaveLength(1);

    // One recovery row is shared by both dependents -- and blocks neither of
    // them (BLO-28618). Both dependents keep only their real leaf blocker.
    const escalationEdges = await db
      .select({ blockedIssueId: issueRelations.relatedIssueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.issueId, escalations[0]!.id)));
    expect(escalationEdges).toEqual([]);

    for (const dependentId of [blockedIssueId, secondBlockedIssueId]) {
      const blockers = await db
        .select({ blockerIssueId: issueRelations.issueId })
        .from(issueRelations)
        .where(and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, dependentId),
        ));
      expect(blockers.map((row) => row.blockerIssueId)).toEqual([blockerIssueId]);
    }
  });

  it("holds a recently closed matching escalation, and keeps holding past the cooldown while the target is unchanged", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatSvc;
    const now = new Date();
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);
    const closedEscalationId = await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      resolvedAt: now,
      // No `completedAt`: this row is closed through the `coalesce` fallback.
      completedAt: null,
    });

    const held = await heartbeat.reconcileIssueGraphLiveness({ now });

    expect(held.escalationsCreated).toBe(0);
    expect(held.skippedReescalationCooldown).toBe(1);
    expect(held.skippedUnchangedTarget).toBe(0);

    // BLO-27676: past the cooldown this used to re-raise unconditionally, which
    // is what made the class non-terminating -- an unchanged target regenerated
    // the same leaf fingerprint every ~75 min indefinitely. The leaf here has not
    // been touched since the escalation resolved, so the report has already been
    // delivered and nothing about it has changed. Stay silent.
    const stillHeld = await heartbeat.reconcileIssueGraphLiveness({
      now: new Date(now.getTime() + DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS + 1),
    });

    expect(stillHeld.escalationsCreated).toBe(0);
    expect(stillHeld.skippedUnchangedTarget).toBe(1);

    const escalations = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "harness_liveness_escalation"),
          eq(issues.originId, incidentKey),
        ),
      );
    expect(escalations.map((row) => row.id)).toEqual([closedEscalationId]);
  });

  it("re-escalates once the leaf target has been touched since the escalation resolved", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatSvc;
    const now = new Date();
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);

    // Resolve 50h ago, touch the leaf 30h ago: after the resolution (so this
    // suppressor re-arms) but still >24h quiet (so the finding fires at all).
    // See `seedResolvedEscalation`'s `leafQuietSince` note for why the second
    // half matters.
    const resolvedAt = new Date(now.getTime() - 50 * 60 * 60 * 1000);
    const touchedAt = new Date(now.getTime() - 30 * 60 * 60 * 1000);

    await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      resolvedAt,
      leafQuietSince: touchedAt,
    });

    const result = await heartbeat.reconcileIssueGraphLiveness({ now });

    expect(result.escalationsCreated).toBe(1);
    expect(result.skippedUnchangedTarget).toBe(0);
    expect(result.skippedReescalationCooldown).toBe(0);

    // BLO-28618: the re-escalation path creates a fresh row, so it is a second
    // place the self-blocker edge could be written. The dedicated test above
    // covers first-time creation; this asserts the same invariant on re-escalation,
    // where only the pre-existing real blocker may survive.
    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.map((row) => row.blockerIssueId)).toEqual([blockerIssueId]);
  });

  it("picks the most recently resolved escalation even when an older row was edited after it closed", async () => {
    // Regression for the sort-key/value-key mismatch (BLO-27676 review): the
    // query ordered by `updatedAt` but compared `completedAt ?? updatedAt`, so a
    // post-close edit to an OLDER escalation made it win the sort while
    // contributing its older resolution timestamp. That fails OPEN -- the leaf
    // touch then reads as "after the resolution" and the class re-escalates every
    // sweep, reinstating exactly the loop this suppressor removes.
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const now = new Date();
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);

    // Two resolutions straddling one leaf touch. The leaf is quiet for 50h, so
    // the finding still fires (>=24h staleness); the newer resolution is 30h old,
    // so it is outside the 60m cooldown and inside the 7d ceiling.
    const olderResolvedAt = new Date(now.getTime() - 100 * 60 * 60 * 1000);
    const leafTouchedAt = new Date(now.getTime() - 50 * 60 * 60 * 1000);
    const newerResolvedAt = new Date(now.getTime() - 30 * 60 * 60 * 1000);

    await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      title: "Closed escalation (older, edited after close)",
      resolvedAt: olderResolvedAt,
      // The post-close edit: a retitle/label/assignee change bumps `updatedAt`
      // long after `completedAt`. This is what used to win the ORDER BY.
      updatedAt: new Date(now.getTime() - 60 * 1000),
    });
    await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      title: "Closed escalation (most recently resolved)",
      identifier: "CLOSED-4",
      issueNumber: 4,
      resolvedAt: newerResolvedAt,
      leafQuietSince: leafTouchedAt,
    });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness({ now });

    // The leaf touch predates the LATEST resolution, so the report is already
    // delivered and nothing has changed since: stay silent.
    expect(result.escalationsCreated).toBe(0);
    expect(result.skippedUnchangedTarget).toBe(1);
  });

  it("re-escalates an untouched leaf once the suppression ceiling has elapsed", async () => {
    // The target-state gate is what lets this class terminate, but unbounded it
    // is permanent: the leaf is quiet by construction, so an escalation closed
    // `done` without giving the leaf an action path would never be re-reported --
    // a silent hole in a liveness detector. The ceiling bounds it to weekly.
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const now = new Date();
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);

    // Resolved 8d ago, past the 7d ceiling, and the leaf has NOT been touched
    // since (9d quiet). Without the ceiling this is suppressed forever.
    const resolvedAt = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    const leafQuietSince = new Date(now.getTime() - 9 * 24 * 60 * 60 * 1000);

    await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      resolvedAt,
      leafQuietSince,
    });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness({ now });

    expect(result.escalationsCreated).toBe(1);
    expect(result.skippedUnchangedTarget).toBe(0);
    expect(result.skippedReescalationCooldown).toBe(0);
  });

  it("holds an untouched leaf inside the suppression ceiling", async () => {
    // Companion to the test above: the ceiling must not be so eager that it
    // re-opens the ~75 min loop. Same fixture, resolved 30h ago instead of 8d.
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const now = new Date();
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);

    const resolvedAt = new Date(now.getTime() - 30 * 60 * 60 * 1000);
    const leafQuietSince = new Date(now.getTime() - 40 * 60 * 60 * 1000);

    await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      resolvedAt,
      leafQuietSince,
    });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness({ now });

    expect(result.escalationsCreated).toBe(0);
    expect(result.skippedUnchangedTarget).toBe(1);
  });

  it("holds a leaf whose escalation closed with completed_at ahead of updated_at at the horizon edge", async () => {
    // Regression test for the scan bound, not for the suppressor logic.
    //
    // The suppressor ORDERS and COMPARES on `coalesce(completed_at, updated_at)`
    // but must FILTER on bare `updated_at`, because only the bare column is
    // servable by `issues_company_updated_idx` and the alternative is an
    // unbounded scan of the company's entire escalation history. Those two
    // columns are NOT the same instant: `services/issues.ts` stamps `updatedAt`
    // when it builds its patch and then `applyStatusSideEffects` sets
    // `completedAt` from a second, later clock read in the same request. So
    // `completed_at` LEADS `updated_at` on the primary close path -- the
    // direction that breaks a naive bound.
    //
    // This fixture is that row, positioned so the two columns straddle the
    // horizon: `completed_at` is 5s INSIDE the 7d ceiling (so the target-state
    // branch must suppress) while `updated_at` is 5s OUTSIDE it. Bounding at
    // `now - horizon` filters the row out, the suppressor returns null, and the
    // escalation re-raises -- the loop BLO-27676 closes, through a narrower
    // door. `LIVENESS_SUPPRESSION_SCAN_SKEW_MS` absorbs the gap.
    //
    // Falsified before being trusted: with the skew term removed from
    // `horizonCutoff` this fails `expected 1 to be +0`.
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const now = new Date();
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);

    // Derived, never hardcoded: the whole value of this fixture is positional --
    // `completedAt` 5s inside the ceiling and `updatedAt` 5s outside it, so the
    // row is reachable ONLY via the skew allowance. A literal `7 * 24 * ...`
    // would not fail if the constant were tuned upward; both columns would land
    // well inside the wider horizon, the row would pass the filter with or
    // without skew, and the assertions would still hold -- the test would stop
    // testing the boundary silently, exactly when someone is changing the thing
    // it guards.
    const ceilingMs = DEFAULT_LIVENESS_UNCHANGED_TARGET_SUPPRESSION_MS;
    const completedAt = new Date(now.getTime() - ceilingMs + 5_000);
    const updatedAt = new Date(now.getTime() - ceilingMs - 5_000);
    // Quiet well before the resolution, so the leaf-activity check cannot be
    // what decides this test.
    const leafQuietSince = new Date(now.getTime() - ceilingMs - 24 * 60 * 60 * 1000);

    await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      // `resolvedAt` only backdates `createdAt` here; the two columns the
      // suppressor and the bound read are both passed explicitly.
      resolvedAt: completedAt,
      completedAt,
      updatedAt,
      leafQuietSince,
    });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness({ now });

    expect(result.escalationsCreated).toBe(0);
    expect(result.skippedUnchangedTarget).toBe(1);
  });

  it("falls back to time-only suppression when the target-state gate is disabled", async () => {
    // Exercises the documented rollback lever: the docblocks on
    // `findSuppressingResolvedLivenessRecoveryIssue` and
    // `DEFAULT_LIVENESS_UNCHANGED_TARGET_SUPPRESSION_MS` both tell a caller to
    // pass `unchangedTargetSuppressionMs: 0` for pre-BLO-27676 behaviour, and
    // nothing exercised that path before.
    //
    // Scope note, so this is not mistaken for more than it is: this test does
    // NOT pin the wrapper opts-type fix that made the option reachable. Test
    // files are not typechecked (`server/tsconfig.json` excludes `src/__tests__`)
    // and the wrapper spreads `{ ...opts }`, so this passes with or without the
    // field declared. What pins that is the typechecked production callers under
    // `src/`. This test pins the BEHAVIOUR of the disable path only.
    //
    // Fixture is deliberately the one from "holds an untouched leaf inside the
    // suppression ceiling" -- resolved 30h ago, leaf quiet 40h, i.e. inside the
    // 7d ceiling and past the 60m cooldown. That case is held by the target-state
    // gate and by nothing else, so flipping the gate off flips the outcome.
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const now = new Date();
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);

    const resolvedAt = new Date(now.getTime() - 30 * 60 * 60 * 1000);
    const leafQuietSince = new Date(now.getTime() - 40 * 60 * 60 * 1000);

    await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      resolvedAt,
      leafQuietSince,
    });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness({
      now,
      unchangedTargetSuppressionMs: 0,
    });

    expect(result.escalationsCreated).toBe(1);
    expect(result.skippedUnchangedTarget).toBe(0);
    expect(result.skippedReescalationCooldown).toBe(0);
  });

  it("suppresses nothing when both re-escalation suppressors are disabled", async () => {
    // The fully-disabled configuration: `cooldownMs <= 0` AND
    // `unchangedTargetSuppressionMs <= 0`. Guards the early return that skips the
    // `mostRecentDone` query in that case -- the assertion is behavioural (a row
    // resolved 90 seconds ago, well inside the default 60m cooldown, still
    // re-escalates), so the guard cannot be "optimised" into changing behaviour.
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const now = new Date();
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);

    const resolvedAt = new Date(now.getTime() - 90 * 1000);
    const leafQuietSince = new Date(now.getTime() - 40 * 60 * 60 * 1000);

    await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      resolvedAt,
      leafQuietSince,
    });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness({
      now,
      reescalationCooldownMs: 0,
      unchangedTargetSuppressionMs: 0,
    });

    expect(result.escalationsCreated).toBe(1);
    expect(result.skippedUnchangedTarget).toBe(0);
    expect(result.skippedReescalationCooldown).toBe(0);
  });

  it("still holds on the target gate when only the cooldown is disabled", async () => {
    // The third combination of the two knobs, and the one the docblock sentence
    // on `findSuppressingResolvedLivenessRecoveryIssue` specifically describes:
    // "passing 0 no longer disables re-escalation suppression outright, it
    // disables the weaker of the two". An operator reaching for the old
    // `reescalationCooldownMs: 0` lever expecting it to turn suppression off
    // gets the target gate instead, so that sentence is worth pinning.
    //
    // Same 90s-resolved fixture as the fully-disabled test above: well inside
    // the default 60m cooldown, so with the cooldown ON it is held as
    // "cooldown". With the cooldown OFF the only thing that can hold it is the
    // target gate, and the leaf has been quiet since before the resolution.
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const now = new Date();
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);

    await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      resolvedAt: new Date(now.getTime() - 90 * 1000),
      leafQuietSince: new Date(now.getTime() - 40 * 60 * 60 * 1000),
    });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness({
      now,
      reescalationCooldownMs: 0,
    });

    expect(result.escalationsCreated).toBe(0);
    // Attributed to the target gate, not to the cooldown that is switched off:
    // `skippedReescalationCooldown` is the aggregate across both suppressors, so
    // the cooldown-only count is the difference, here zero.
    expect(result.skippedUnchangedTarget).toBe(1);
    expect(result.skippedReescalationCooldown).toBe(1);
  });

  it("subtracts suppressed findings from the operator preview, matching what a run would create", async () => {
    // BLO-27676 review: the preview and the run are paired operator endpoints
    // (`/issue-graph-liveness-auto-recovery/preview` and `.../run`), and the
    // confirm dialog renders `recoverableFindings` as the label on the button
    // that triggers the run ("Enable and create N"). The preview used to filter
    // on staleness alone, so a suppressed finding was counted as one the run
    // would create. The steady-state case was a preview listing n and a run
    // creating zero, because the target-state gate spans 7d and selects exactly
    // the population an operator previews: leaves already reported once and
    // since quiet.
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const now = new Date();
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);

    // Held by the target gate and by nothing else: outside the 60m cooldown,
    // inside the 7d ceiling, leaf quiet since before the resolution.
    await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      resolvedAt: new Date(now.getTime() - 30 * 60 * 60 * 1000),
      leafQuietSince: new Date(now.getTime() - 40 * 60 * 60 * 1000),
    });

    const preview = await heartbeatSvc.buildIssueGraphLivenessAutoRecoveryPreview({ now });

    expect(preview.findings).toBe(1);
    expect(preview.recoverableFindings).toBe(0);
    expect(preview.items).toHaveLength(0);
    expect(preview.skippedReescalationCooldown).toBe(1);
    expect(preview.skippedUnchangedTarget).toBe(1);
    // Not the reason this finding is held -- asserted so a future staleness
    // change cannot make this test pass for the wrong reason.
    expect(preview.skippedOutsideLookback).toBe(0);

    // The invariant the finding is about, asserted directly rather than through
    // two independently hardcoded numbers: the preview promises exactly what
    // pressing run delivers. Preview is read-only, so this ordering is safe.
    const run = await heartbeatSvc.reconcileIssueGraphLiveness({ now });

    expect(run.escalationsCreated).toBe(preview.recoverableFindings);
    expect(run.skippedReescalationCooldown).toBe(preview.skippedReescalationCooldown);
    expect(run.skippedUnchangedTarget).toBe(preview.skippedUnchangedTarget);
  });

  it("still previews an unowned backlog blocker that has never been reported", async () => {
    // Rejection test for the preview change: it must not degrade into "the
    // preview shows nothing". A leaf with no owner and no prior resolved
    // escalation is unsuppressed, so it stays listed -- and the same
    // preview/run equality has to hold in the other direction.
    await enableAutoRecovery();
    const { blockerIssueId } = await seedBlockedChain({ blockerStatus: "backlog" });
    const now = new Date();

    const preview = await heartbeatSvc.buildIssueGraphLivenessAutoRecoveryPreview({ now });

    expect(preview.recoverableFindings).toBe(1);
    expect(preview.items).toHaveLength(1);
    expect(preview.skippedReescalationCooldown).toBe(0);
    expect(preview.skippedUnchangedTarget).toBe(0);
    expect(preview.items[0]?.incidentKey.endsWith(`:${blockerIssueId}`)).toBe(true);

    const run = await heartbeatSvc.reconcileIssueGraphLiveness({ now });

    expect(run.escalationsCreated).toBe(preview.recoverableFindings);
  });

  it("previews the documented rollback lever rather than the default windows", async () => {
    // The preview takes the same two suppression knobs as the run, for the same
    // reason the run does: an operator who has rolled the target gate back has
    // to be able to preview the run that lever actually produces. Without the
    // options on the preview, the disable path is previewable only as the
    // default 7d behaviour -- i.e. the surface would still lie, just in the
    // opposite direction.
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const now = new Date();
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);

    await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      resolvedAt: new Date(now.getTime() - 30 * 60 * 60 * 1000),
      leafQuietSince: new Date(now.getTime() - 40 * 60 * 60 * 1000),
    });

    // Both readings of one fixture, so this fails in either direction: if the
    // preview ignored the suppressors the default reading would be 1, and if it
    // ignored the option the rolled-back reading would be 0.
    const withDefaults = await heartbeatSvc.buildIssueGraphLivenessAutoRecoveryPreview({ now });

    expect(withDefaults.recoverableFindings).toBe(0);
    expect(withDefaults.skippedUnchangedTarget).toBe(1);
    // The confirm dialog states each suppressor's bound from these fields rather
    // than restating the constants, because both suppressors expire and an
    // unqualified "will not be re-raised" describes the unbounded behaviour the
    // ceiling was added to remove (BLO-27676 review). So the preview has to echo
    // the windows it actually resolved.
    expect(withDefaults.reescalationCooldownMs).toBe(DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS);
    expect(withDefaults.unchangedTargetSuppressionMs).toBe(
      DEFAULT_LIVENESS_UNCHANGED_TARGET_SUPPRESSION_MS,
    );

    const preview = await heartbeatSvc.buildIssueGraphLivenessAutoRecoveryPreview({
      now,
      unchangedTargetSuppressionMs: 0,
    });

    expect(preview.recoverableFindings).toBe(1);
    expect(preview.skippedReescalationCooldown).toBe(0);
    expect(preview.skippedUnchangedTarget).toBe(0);
    // An override has to travel too: echoing the default here would have the
    // dialog promise a 7d hold on a run whose target gate is switched off.
    expect(preview.unchangedTargetSuppressionMs).toBe(0);

    const run = await heartbeatSvc.reconcileIssueGraphLiveness({
      now,
      unchangedTargetSuppressionMs: 0,
    });

    expect(run.escalationsCreated).toBe(preview.recoverableFindings);
  });

  it("still escalates an unowned backlog blocker that has never been reported", async () => {
    // Rejection test for the suppressor above: it must not degrade into "stop
    // escalating". A leaf with no owner, no disposition and no prior resolved
    // escalation is exactly the shape the detector exists to catch.
    await enableAutoRecovery();
    const { companyId, blockerIssueId } = await seedBlockedChain({ blockerStatus: "backlog" });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();

    expect(result.escalationsCreated).toBe(1);
    expect(result.skippedUnchangedTarget).toBe(0);
    expect(result.skippedReescalationCooldown).toBe(0);

    const [escalation] = await db
      .select({ parentId: issues.parentId })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "harness_liveness_escalation"),
        ),
      );
    expect(escalation?.parentId).toBe(blockerIssueId);
  });

  // BLO-28957 reverses this case deliberately, so the rename is the point.
  //
  // It used to assert "re-escalates immediately after a matching escalation is
  // cancelled", on the reading that a cancelled row was dismissed without being
  // worked, so the incident still needed attention right now. That reading does
  // not survive the abandonment bound: `cancelled` is also how the sweep RETIRES
  // a row, so a `done`-only cooldown left the re-file loop this cooldown exists
  // to stop wide open -- retire, re-file, repeat (240 of 500 sampled rows on
  // 2026-08-18). The cooldown now holds `cancelled` too.
  //
  // The second half is what keeps this from being a regression: the incident is
  // held for one cooldown, not dropped.
  it("holds re-escalation for one cooldown after a matching escalation is cancelled", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatSvc;
    const now = new Date();
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);

    await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      status: "cancelled",
      title: "Cancelled escalation",
      identifier: "CANCELLED-3",
      resolvedAt: now,
      completedAt: null,
    });

    const held = await heartbeat.reconcileIssueGraphLiveness({ now });

    expect(held.escalationsCreated).toBe(0);
    expect(held.skippedReescalationCooldown).toBe(1);

    // Held, not dropped: once the cooldown expires the finding speaks again.
    // This is the assertion that separates "cancelled joins the cooldown" from
    // "cancelled joins the 7-day target-state suppressor" -- the latter would
    // leave this at 0 and is what makes the narrow, cooldown-only scoping in
    // `findSuppressingResolvedLivenessRecoveryIssue` load-bearing.
    const after = await heartbeat.reconcileIssueGraphLiveness({
      now: new Date(now.getTime() + DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS + 60 * 1000),
    });

    expect(after.escalationsCreated).toBe(1);
  });

  /**
   * An OPEN recovery row for the seeded chain's own incident, with the row's
   * activity clock backdated by `idleMs`.
   *
   * While open, this row suppresses liveness findings for the source AND the
   * leaf (`openRecoveryIssues` maps one row onto both ids), with no blocker edge
   * involved -- which is what makes the wedge in BLO-28957 invisible: the source
   * is not `blocked`, it is simply never reported.
   */
  async function seedOpenRecoveryRow(opts: { idleMs: number }) {
    const seeded = await seedBlockedChain();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = seeded;
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);
    const recoveryIssueId = randomUUID();
    // Backdate `createdAt` with the activity so the row never has
    // `updatedAt` < `createdAt` -- an ordering no real row can have, and one
    // `issueCreatedAtGte` could trip over for reasons unrelated to this
    // behaviour.
    const idleAt = new Date(Date.now() - opts.idleMs);

    await db.insert(issues).values({
      id: recoveryIssueId,
      companyId,
      title: "Unblock liveness incident",
      status: "todo",
      priority: "high",
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      issueNumber: 7,
      identifier: `${`P${companyId.replace(/-/g, "").slice(0, 4)}`}-7`,
      originKind: "harness_liveness_escalation",
      originId: incidentKey,
      createdAt: new Date(idleAt.getTime() - 60 * 60 * 1000),
      updatedAt: idleAt,
      lastActivityAt: idleAt,
    });

    return { ...seeded, incidentKey, recoveryIssueId };
  }

  // BLO-28957 (a). Pre-fix the source-still-open skip has no exit, so this row
  // is skipped forever (`sourceStillOpenSkipped` 1, `retired` 0) and the source
  // has no wake path at all while it sits there.
  it("retires an abandoned recovery row whose source is still open, restoring the source's wake path", async () => {
    await enableAutoRecovery();
    const { companyId, blockedIssueId, recoveryIssueId } = await seedOpenRecoveryRow({
      idleMs: DEFAULT_LIVENESS_ABANDONED_RECOVERY_MS + 24 * 60 * 60 * 1000,
    });

    const swept = await heartbeatSvc.reconcileIssueGraphLiveness({ now: new Date() });

    // Behavioural assertion first, so a pre-fix run fails on the defect itself
    // (the row is never retired) rather than on a counter that does not exist
    // yet. Pre-fix this reads "todo".
    const [recovery] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, recoveryIssueId));
    expect(recovery?.status).toBe("cancelled");

    expect(swept.obsoleteRecoveriesAbandonedRetired).toBe(1);
    expect(swept.obsoleteRecoveriesSourceStillOpenSkipped).toBe(0);
    // The row still suppresses its own finding on the sweep that retires it --
    // findings are collected before the retire runs. That is why the wake path
    // is restored on the NEXT sweep, not this one (asserted by case (b)).
    expect(swept.findings).toBe(0);

    // Retiring the row is not a source-status change: the source stays open.
    const [source] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, blockedIssueId));
    expect(["done", "cancelled"]).not.toContain(source?.status);

    // Discoverable without reading sweep logs. The activity row is keyed to the
    // SOURCE, so "which sources were suppressed by an abandoned row" is a query;
    // the marker comment explains the cancellation in place.
    const abandonedActivity = await db
      .select({ entityId: activityLog.entityId })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.liveness_recovery_abandoned"),
        ),
      );
    expect(abandonedActivity).toHaveLength(1);
    expect(abandonedActivity[0]?.entityId).toBe(blockedIssueId);

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, recoveryIssueId));
    expect(comments.some((row) => row.body.includes(ABANDONED_LIVENESS_RECOVERY_MARKER))).toBe(true);
  });

  // BLO-28957 (b) -- the load-bearing assertion. An age bound ALONE fails here:
  // the retire cancels the row, and on a `done`-only cooldown the very next
  // sweep sees nothing open and re-files, which is the loop BLO-28618 exists to
  // kill. This pins the bound and the widened cooldown as one change.
  it("does not re-file an abandoned recovery row on the sweep immediately after retiring it", async () => {
    await enableAutoRecovery();
    const { companyId } = await seedOpenRecoveryRow({
      idleMs: DEFAULT_LIVENESS_ABANDONED_RECOVERY_MS + 24 * 60 * 60 * 1000,
    });

    const retiredAt = new Date();
    await heartbeatSvc.reconcileIssueGraphLiveness({ now: retiredAt });

    // Immediately following sweep: the source is reportable again (nothing
    // suppresses it now) but must NOT get a fresh row.
    //
    // Both assertions fail pre-fix, for the two separate reasons this issue
    // exists: `findings` is 0 because the abandoned row is still open and still
    // suppressing, and `skippedReescalationCooldown` is 0 because a `done`-only
    // cooldown would not have held a cancelled row anyway.
    const following = await heartbeatSvc.reconcileIssueGraphLiveness({
      now: new Date(retiredAt.getTime() + 60 * 1000),
    });

    expect(following.findings).toBe(1);
    expect(following.skippedReescalationCooldown).toBe(1);
    expect(following.escalationsCreated).toBe(0);

    const stillOpen = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "harness_liveness_escalation"),
          eq(issues.status, "todo"),
        ),
      );
    expect(stillOpen).toHaveLength(0);

    // Bounded, not dropped: once the cooldown expires the source gets a fresh
    // row with a fresh owner. This is the "regains a wake path within a bounded,
    // stated interval" half of the acceptance criteria, and it is also what
    // proves `cancelled` joined the 60m cooldown rather than the 7d
    // target-state suppressor.
    const reescalated = await heartbeatSvc.reconcileIssueGraphLiveness({
      now: new Date(retiredAt.getTime() + DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS + 60 * 1000),
    });

    expect(reescalated.escalationsCreated).toBe(1);

    const refiled = await db
      .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "harness_liveness_escalation"),
          eq(issues.status, "todo"),
        ),
      );
    expect(refiled).toHaveLength(1);
    expect(refiled[0]?.assigneeAgentId).toBeTruthy();
  });

  // BLO-28957 (c): over-retiring guard. A row someone touched recently is
  // suppressing legitimately -- an owner slow to pick a row up is not an
  // abandoned row -- so it must stay open and keep counting as
  // `sourceStillOpenSkipped`.
  it("keeps suppressing and does not retire a recovery row with recent activity", async () => {
    await enableAutoRecovery();
    const { recoveryIssueId } = await seedOpenRecoveryRow({ idleMs: 60 * 60 * 1000 });

    const swept = await heartbeatSvc.reconcileIssueGraphLiveness({ now: new Date() });

    expect(swept.findings).toBe(0);
    expect(swept.obsoleteRecoveriesAbandonedRetired).toBe(0);
    expect(swept.obsoleteRecoveriesSourceStillOpenSkipped).toBe(1);
    expect(swept.obsoleteRecoveriesRetired).toBe(0);

    const [recovery] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, recoveryIssueId));
    expect(recovery?.status).toBe("todo");
  });

  // BLO-29761: the suppression decision is persisted, so "suppressed by
  // history" is distinguishable from "never detected". Before this, the filing
  // path wrote `issue.harness_liveness_escalation_created` and the suppression
  // path wrote nothing, leaving row titles as the only evidence -- which is the
  // method that produced this issue's own false 470/496 census.
  async function readSuppressionEvents(companyId: string) {
    const events = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.harness_liveness_escalation_suppressed"),
        ),
      );
    return events;
  }

  it("records a cooldown suppression against the prior done row, with its status", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const now = new Date();
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);
    const closedEscalationId = await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      resolvedAt: now,
      identifier: "CLOSED-COOLDOWN",
    });

    const held = await heartbeatSvc.reconcileIssueGraphLiveness({ now });
    expect(held.escalationsCreated).toBe(0);
    expect(held.skippedReescalationCooldown).toBe(1);

    const events = await readSuppressionEvents(companyId);
    expect(events).toHaveLength(1);
    expect(events[0]?.entityId).toBe(blockedIssueId);
    expect(events[0]?.details).toMatchObject({
      reason: "cooldown",
      incidentKey,
      suppressedByIssueId: closedEscalationId,
      suppressedByIdentifier: "CLOSED-COOLDOWN",
      // The amended AC: carry the prior row's status so a suppression sourced
      // from a `cancelled` row stays distinguishable once BLO-29838 lands.
      suppressedByStatus: "done",
      leafIssueId: blockerIssueId,
      findingState: "blocked_by_unassigned_issue",
      sourceIssueId: blockedIssueId,
    });
  });

  it("records an unchanged_target suppression, distinguishably from a cooldown one", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const now = new Date();
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);
    const closedEscalationId = await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      // Outside the 60m cooldown, inside the 7d ceiling, leaf quiet since
      // before the resolution -- held by the target gate and nothing else.
      resolvedAt: new Date(now.getTime() - 30 * 60 * 60 * 1000),
      leafQuietSince: new Date(now.getTime() - 40 * 60 * 60 * 1000),
      identifier: "CLOSED-TARGET",
    });

    const held = await heartbeatSvc.reconcileIssueGraphLiveness({ now });
    expect(held.skippedUnchangedTarget).toBe(1);

    const events = await readSuppressionEvents(companyId);
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({
      reason: "unchanged_target",
      suppressedByIssueId: closedEscalationId,
      suppressedByStatus: "done",
    });
  });

  it("records an existing-open suppression, distinguishably from the resolved-history branch", async () => {
    // Two dependents share one leaf blocker, so the sweep produces two findings
    // and the second is suppressed by the row the first just created. This is
    // the `existing` branch: an OPEN row owns the incident, which an operator
    // must be able to tell apart from "a CLOSED row suppressed this".
    await enableAutoRecovery();
    const { companyId, blockerIssueId } = await seedBlockedChain();
    const secondBlockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const issueTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db.insert(issues).values({
      id: secondBlockedIssueId,
      companyId,
      title: "Second blocked parent",
      status: "blocked",
      priority: "medium",
      issueNumber: 3,
      identifier: `${issuePrefix}-3`,
      createdAt: issueTimestamp,
      updatedAt: issueTimestamp,
      lastActivityAt: issueTimestamp,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: secondBlockedIssueId,
      type: "blocks",
    });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();
    expect(result.escalationsCreated).toBe(1);
    expect(result.existingEscalations).toBe(1);

    const [escalation] = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "harness_liveness_escalation")));

    const events = await readSuppressionEvents(companyId);
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({
      reason: "existing_open",
      suppressedByIssueId: escalation?.id,
      // Not `done`/`cancelled` -- this is what makes the open branch legible.
      suppressedByStatus: escalation?.status,
    });

    // Counting suppressions for the period is one filter on the activity log:
    // no title parsing, no inference from row counts.
    const all = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(all.filter((e) => e.action === "issue.harness_liveness_escalation_created")).toHaveLength(1);
  });

  it("writes no suppression row for a first filing", async () => {
    // Regression guard: observability must not start narrating the happy path.
    await enableAutoRecovery();
    const { companyId } = await seedBlockedChain({ blockerStatus: "backlog" });

    const result = await heartbeatSvc.reconcileIssueGraphLiveness();
    expect(result.escalationsCreated).toBe(1);

    const events = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(events.some((e) => e.action === "issue.harness_liveness_escalation_created")).toBe(true);
    expect(await readSuppressionEvents(companyId)).toHaveLength(0);
  });

  it("records one row per suppression decision, not one per sweep", async () => {
    // The load-bearing property. A suppressed finding is re-evaluated on EVERY
    // heartbeat tick (default 30s) for as long as it stays suppressed -- up to
    // the 7d ceiling. Logging per evaluation would be ~2,880 rows per incident
    // per day across ~400 in-window incidents on two replicas, which would bury
    // the signal this row exists to surface. The unit of record is therefore
    // the decision `(incidentKey, reason, suppressedByIssueId)`, and re-running
    // the identical sweep must add nothing.
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const now = new Date();
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);
    await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      resolvedAt: now,
      completedAt: null,
    });

    await heartbeatSvc.reconcileIssueGraphLiveness({ now });
    await heartbeatSvc.reconcileIssueGraphLiveness({ now: new Date(now.getTime() + 30 * 1000) });
    await heartbeatSvc.reconcileIssueGraphLiveness({ now: new Date(now.getTime() + 60 * 1000) });

    const events = await readSuppressionEvents(companyId);
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({ reason: "cooldown" });
  });

  it("records the cooldown -> unchanged_target handover as a second decision", async () => {
    // The rejection test for the dedupe above: it must collapse repeats without
    // collapsing genuine changes. When the cooldown lapses and the target-state
    // gate takes over, the reason changed, so the log must say so -- otherwise
    // "why is this still suppressed on day 6?" is unanswerable.
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const now = new Date();
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);
    await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      resolvedAt: now,
      completedAt: null,
    });

    await heartbeatSvc.reconcileIssueGraphLiveness({ now });
    await heartbeatSvc.reconcileIssueGraphLiveness({
      now: new Date(now.getTime() + DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS + 1),
    });

    const events = await readSuppressionEvents(companyId);
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.details as Record<string, unknown>).reason).sort()).toEqual([
      "cooldown",
      "unchanged_target",
    ]);
  });

  it("does not write suppression activity rows from the operator preview", async () => {
    // A read-only preview must not be indistinguishable from a run in the audit
    // log. This holds structurally -- the preview calls the suppressor directly
    // rather than through `createIssueGraphLivenessEscalation`, which is where
    // the write lives -- and is pinned here so unifying the two paths cannot
    // silently start forging run records from a preview.
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const now = new Date();
    const incidentKey = livenessIncidentKey(companyId, blockedIssueId, blockerIssueId);
    await seedResolvedEscalation({
      companyId,
      managerId,
      blockerIssueId,
      incidentKey,
      resolvedAt: new Date(now.getTime() - 30 * 60 * 60 * 1000),
      leafQuietSince: new Date(now.getTime() - 40 * 60 * 60 * 1000),
    });

    const before = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));

    const preview = await heartbeatSvc.buildIssueGraphLivenessAutoRecoveryPreview({ now });
    expect(preview.skippedUnchangedTarget).toBe(1);

    const after = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(after).toHaveLength(before.length);
    expect(await readSuppressionEvents(companyId)).toHaveLength(0);

    // And the run that the preview predicted DOES write one, so the assertion
    // above is about the preview rather than about the fixture being inert.
    await heartbeatSvc.reconcileIssueGraphLiveness({ now });
    expect(await readSuppressionEvents(companyId)).toHaveLength(1);
  });

  // Drain path for the legacy edges filed before BLO-28618 stopped writing
  // them. The escalation is seeded with the edge by hand because the detector
  // no longer produces that shape.
  it("prunes a legacy escalation blocker edge and lifts the source out of blocked", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatSvc;
    const legacyEscalationId = randomUUID();
    const incidentKey = [
      "harness_liveness",
      companyId,
      blockedIssueId,
      "blocked_by_unassigned_issue",
      blockerIssueId,
    ].join(":");

    await db.insert(issues).values({
      id: legacyEscalationId,
      companyId,
      title: "Unblock liveness incident (legacy)",
      status: "done",
      priority: "high",
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      issueNumber: 9,
      identifier: "LEGACY-9",
      originKind: "harness_liveness_escalation",
      originId: incidentKey,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: legacyEscalationId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
    // The real leaf is resolved, so once the fabricated edge goes the source has
    // no unresolved blockers left -- exactly the state that used to be left
    // behind as `blocked` with an empty blocker set (the `blocked_without_blockers`
    // trigger, measured at 11 of 11 sources on 2026-08-18).
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerIssueId));

    const result = await heartbeat.reconcileIssueGraphLiveness();
    expect(result.doneRecoveryBlockerRelationsRemoved).toBe(1);

    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.some((row) => row.blockerIssueId === legacyEscalationId)).toBe(false);

    const [sourceAfter] = await db.select().from(issues).where(eq(issues.id, blockedIssueId));
    expect(sourceAfter?.status).toBe("todo");

    const pruneEvent = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "issue.liveness_recovery_blocker_pruned"),
        eq(activityLog.entityId, blockedIssueId),
      ))
      .then((rows) => rows.at(-1));
    expect(pruneEvent?.details).toMatchObject({
      recoveryIssueId: legacyEscalationId,
      previousStatus: "blocked",
      remainingUnresolvedBlockerCount: 0,
      restoredSourceStatus: true,
    });
  });

  // Counterpart: a real remaining blocker must keep the source `blocked`.
  it("keeps the source blocked when a real blocker survives the legacy prune", async () => {
    await enableAutoRecovery();
    const { companyId, managerId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatSvc;
    const legacyEscalationId = randomUUID();

    await db.insert(issues).values({
      id: legacyEscalationId,
      companyId,
      title: "Unblock liveness incident (legacy)",
      status: "cancelled",
      priority: "high",
      parentId: blockerIssueId,
      assigneeAgentId: managerId,
      issueNumber: 9,
      identifier: "LEGACY-9",
      originKind: "harness_liveness_escalation",
      originId: [
        "harness_liveness",
        companyId,
        blockedIssueId,
        "blocked_by_unassigned_issue",
        blockerIssueId,
      ].join(":"),
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: legacyEscalationId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const result = await heartbeat.reconcileIssueGraphLiveness();
    expect(result.doneRecoveryBlockerRelationsRemoved).toBe(1);

    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.map((row) => row.blockerIssueId)).toEqual([blockerIssueId]);

    const [sourceAfter] = await db.select().from(issues).where(eq(issues.id, blockedIssueId));
    expect(sourceAfter?.status).toBe("blocked");
  });

  it("handles an armed cutoff when no liveness findings exist", async () => {
    const heartbeat = heartbeatSvc;

    const result = await heartbeat.reconcileIssueGraphLiveness({
      issueCreatedAtGte: new Date(),
    });

    expect(result.findings).toBe(0);
  });
});
