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

import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { issueService } from "../services/issues.ts";
import { runningProcesses } from "../adapters/index.ts";
import {
  DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS,
  DEFAULT_LIVENESS_UNCHANGED_TARGET_SUPPRESSION_MS,
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

  it("creates one manager escalation, preserves blockers, and records owner selection", async () => {
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

    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.map((row) => row.blockerIssueId).sort()).toEqual(
      [blockerIssueId, escalations[0]!.id].sort(),
    );

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
    expect(events.some((event) => event.action === "issue.blockers.updated")).toBe(true);
  });

  it("rejects a cycle-forming escalation edge and logs the persisted blocker set", async () => {
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
    expect(blockerEvent?.details).toMatchObject({ blockerIssueIds: [blockerIssueId] });
  });

  it("does not strand a zero-pre-existing-blocker source in blocked when the escalation edge would cycle", async () => {
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

    // Source issue is in_review with no assignee and no pre-existing
    // blockers of its own -- the self-referential "in_review_without_action_path"
    // finding treats the issue as both the source and its own recovery
    // issue, so this is the shape that hits the cycle fallback with an
    // empty blockerIds set.
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
    // Craft the cycle: the source issue already blocks the escalation issue
    // (e.g. left over from an earlier partial recovery), so adding the
    // reverse edge -- escalation blocks source -- forms a 2-cycle. The
    // source has no *other* blockers of its own.
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

    const blockers = await db
      .select({ blockedIssueId: issueRelations.relatedIssueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.issueId, escalations[0]!.id)));
    expect(blockers.map((row) => row.blockedIssueId).sort()).toEqual(
      [blockedIssueId, secondBlockedIssueId].sort(),
    );
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

  it("re-escalates immediately after a matching escalation is cancelled", async () => {
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

    const result = await heartbeat.reconcileIssueGraphLiveness({ now });

    expect(result.escalationsCreated).toBe(1);
    expect(result.skippedReescalationCooldown).toBe(0);
  });

  it("removes closed liveness escalations from blocker relations during reconciliation", async () => {
    await enableAutoRecovery();
    const { companyId, blockedIssueId, blockerIssueId } = await seedBlockedChain();
    const heartbeat = heartbeatSvc;

    const first = await heartbeat.reconcileIssueGraphLiveness();
    expect(first.escalationsCreated).toBe(1);

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

    await db
      .update(issues)
      // `blockedByIssueIds` was never a column on the `issues` table — blocker
      // relationships live in `recoveryBlockerIssues`. Status=done is the
      // signal `reconcileIssueGraphLiveness` reads to prune the relation.
      .set({ status: "done" })
      .where(eq(issues.id, escalations[0]!.id));
    await db
      .update(issues)
      // `blockedByIssueIds` was never a column on the `issues` table — blocker
      // relationships live in `recoveryBlockerIssues`. Status=done is the
      // signal `reconcileIssueGraphLiveness` reads to prune the relation.
      .set({ status: "done" })
      .where(eq(issues.id, blockerIssueId));

    const second = await heartbeat.reconcileIssueGraphLiveness();
    expect(second.obsoleteRecoveryBlockerRelationsRemoved).toBe(0);
    expect(second.doneRecoveryBlockerRelationsRemoved).toBe(1);

    const blockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, blockedIssueId));
    expect(blockers.some((row) => row.blockerIssueId === escalations[0]!.id)).toBe(false);
  });

  it("handles an armed cutoff when no liveness findings exist", async () => {
    const heartbeat = heartbeatSvc;

    const result = await heartbeat.reconcileIssueGraphLiveness({
      issueCreatedAtGte: new Date(),
    });

    expect(result.findings).toBe(0);
  });
});
