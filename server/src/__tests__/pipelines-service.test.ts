import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issues,
  pipelineAutomationExecutions,
  pipelineCaseBlockers,
  pipelineCaseIssueLinks,
  pipelineCaseEvents,
  pipelineCases,
  pipelineStages,
  pipelineTransitions,
  pipelines,
  projectWorkspaces,
  projects,
  routineRuns,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE,
  pipelineService,
  type PipelineActor,
} from "../services/pipelines.ts";
import {
  loadDescendantActiveWorkCountsForCases,
  loadPipelineDescendantActiveWorkCounts,
} from "../services/pipelines-aggregation.ts";
import { routineService } from "../services/routines.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { subscribeCompanyLiveEvents } from "../services/live-events.ts";
import { logger } from "../middleware/logger.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pipeline service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pipelineService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof pipelineService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const userActor: PipelineActor = { type: "user", userId: "board-user" };
  const cancelledRunIds: string[] = [];
  const noopHeartbeat = {
    wakeup: async () => null,
    cancelRun: async (runId: string, reason?: string, options?: { errorCode?: string }) => {
      cancelledRunIds.push(runId);
      const [cancelled] = await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: new Date(),
          error: reason ?? null,
          errorCode: options?.errorCode ?? "cancelled",
        })
        .where(eq(heartbeatRuns.id, runId))
        .returning();
      await db
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          checkoutRunId: null,
        })
        .where(eq(issues.executionRunId, runId));
      return cancelled ?? null;
    },
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipelines-service-");
    db = createDb(tempDb.connectionString);
    svc = pipelineService(db, { heartbeat: noopHeartbeat });
  }, 60_000);

  afterEach(async () => {
    cancelledRunIds.length = 0;
    await db.delete(pipelineAutomationExecutions);
    await db.delete(pipelineCaseBlockers);
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(routines);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const [company] = await db.insert(companies).values({
      name: "Pipeline Co",
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    }).returning();
    return company!;
  }

  async function seedPipeline(options?: { enforceTransitions?: boolean }) {
    const company = await seedCompany();
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: `content-${randomUUID().slice(0, 8)}`,
      name: "Content",
      enforceTransitions: options?.enforceTransitions ?? false,
      actor: userActor,
    });
    const stages = await svc.listStages(company.id, pipeline.id);
    return { company, pipeline, stages, byKey: new Map(stages.map((stage) => [stage.key, stage])) };
  }

  async function seedRoutine(companyId: string, title = "Routine") {
    const [agent] = await db.insert(agents).values({
      companyId,
      name: `${title} Agent`,
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    return routineService(db, { heartbeat: noopHeartbeat }).create(companyId, {
      projectId: null,
      goalId: null,
      parentIssueId: null,
      title,
      description: null,
      assigneeAgentId: agent!.id,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "always_enqueue",
      catchUpPolicy: "skip_missed",
    }, {});
  }

  async function eventCount(caseId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pipelineCaseEvents)
      .where(eq(pipelineCaseEvents.caseId, caseId));
    return count ?? 0;
  }

  async function seedLinkedIssue(input: {
    companyId: string;
    caseId: string;
    role: "origin" | "conversation" | "work" | "automation";
    status?: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
    title?: string;
  }) {
    const [issue] = await db.insert(issues).values({
      companyId: input.companyId,
      title: input.title ?? `${input.role} issue`,
      status: input.status ?? "todo",
      priority: "medium",
    }).returning();
    await db.insert(pipelineCaseIssueLinks).values({
      companyId: input.companyId,
      caseId: input.caseId,
      issueId: issue!.id,
      role: input.role,
    });
    return issue!;
  }

  it("seeds default stages and protects non-empty stage deletion", async () => {
    const { company, pipeline, byKey } = await seedPipeline();

    expect([...byKey.keys()]).toEqual(["intake", "in_progress", "review", "done", "cancelled"]);
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "stage-delete",
      title: "Stage delete guard",
      actor: userActor,
    });

    await expect(
      svc.deleteStage({ companyId: company.id, pipelineId: pipeline.id, stageId: byKey.get("intake")!.id }),
    ).rejects.toMatchObject({ status: 422, details: { code: "stage_has_cases" } });

    await svc.deleteStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId: byKey.get("intake")!.id,
      moveCasesToStageId: byKey.get("in_progress")!.id,
    });
    const [moved] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, created.case.id));
    expect(moved!.stageId).toBe(byKey.get("in_progress")!.id);
  });

  it("updates parent terminal counts when deleting a stage moves child cases to done", async () => {
    const { company, pipeline, byKey } = await seedPipeline();
    const parent = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageKey: "in_progress",
      caseKey: "delete-stage-parent",
      title: "Delete stage parent",
      actor: userActor,
    });
    const child = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "delete-stage-child",
      title: "Delete stage child",
      parentCaseId: parent.case.id,
      actor: userActor,
    });

    await svc.deleteStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId: byKey.get("intake")!.id,
      moveCasesToStageId: byKey.get("done")!.id,
    });

    const [freshParent] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, parent.case.id));
    const [freshChild] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, child.case.id));
    expect(freshParent!.childCount).toBe(1);
    expect(freshParent!.terminalChildCount).toBe(1);
    expect(freshChild!.terminalKind).toBe("done");

    await expect(
      svc.transitionCase({
        companyId: company.id,
        caseId: parent.case.id,
        toStageKey: "done",
        expectedVersion: parent.case.version,
        actor: userActor,
      }),
    ).resolves.toMatchObject({ case: { terminalKind: "done" } });
  });

  it("implements idempotent single and batch ingest", async () => {
    const { company, pipeline } = await seedPipeline();

    const first = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "release-1",
      title: "Release 1",
      actor: userActor,
    });
    const second = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "release-1",
      title: "Duplicate title is ignored",
      actor: userActor,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.case.id).toBe(first.case.id);
    expect(await eventCount(first.case.id)).toBe(1);

    await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "existing-2",
      title: "Existing 2",
      actor: userActor,
    });
    const batch = await svc.ingestCases({
      companyId: company.id,
      pipelineId: pipeline.id,
      actor: userActor,
      items: [
        { caseKey: "new-1", title: "New 1" },
        { caseKey: "new-2", title: "New 2" },
        { caseKey: "release-1", title: "Existing 1" },
        { caseKey: "new-3", title: "New 3" },
        { caseKey: "existing-2", title: "Existing 2 again" },
      ],
    });

    expect(batch).toHaveLength(5);
    expect(batch.filter((item) => item.ok && item.created)).toHaveLength(3);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(pipelineCases);
    expect(count).toBe(5);
  });

  it("persists workspaceRef during ingest", async () => {
    const { company, pipeline } = await seedPipeline();
    const workspaceRef = {
      workspacePath: "exports/pipeline-case",
      name: "Pipeline case files",
    };

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "workspace-ref",
      title: "Workspace ref",
      workspaceRef,
      actor: userActor,
    });

    expect(created.case.workspaceRef).toEqual(workspaceRef);
    const [stored] = await db
      .select({ workspaceRef: pipelineCases.workspaceRef })
      .from(pipelineCases)
      .where(eq(pipelineCases.id, created.case.id));
    expect(stored?.workspaceRef).toEqual(workspaceRef);
  });

  it("rejects stale content PATCH without writing an event", async () => {
    const { company, pipeline } = await seedPipeline();
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "patch",
      title: "Patch me",
      actor: userActor,
    });
    await svc.patchCaseContent({
      companyId: company.id,
      caseId: created.case.id,
      title: "Patched",
      expectedVersion: 1,
      actor: userActor,
    });
    const before = await eventCount(created.case.id);

    await expect(
      svc.patchCaseContent({
        companyId: company.id,
        caseId: created.case.id,
        title: "Stale",
        expectedVersion: 1,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "version_conflict", version: 2 } });
    expect(await eventCount(created.case.id)).toBe(before);
  });

  it("lets exactly one parallel transition with the same expectedVersion succeed", async () => {
    const { company, pipeline } = await seedPipeline();
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "parallel",
      title: "Parallel transition",
      actor: userActor,
    });

    const attempts = await Promise.allSettled([
      svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "in_progress",
        expectedVersion: 1,
        actor: userActor,
      }),
      svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "review",
        expectedVersion: 1,
        actor: userActor,
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const [row] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, created.case.id));
    expect(row!.version).toBe(2);
    expect(await eventCount(created.case.id)).toBe(2);
  });

  it("enforces active leases and lets the holder transition with the lease token", async () => {
    const { company, pipeline } = await seedPipeline();
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "lease",
      title: "Leased case",
      actor: userActor,
    });
    const owner: PipelineActor = { type: "user", userId: "owner" };
    const other: PipelineActor = { type: "user", userId: "other" };

    const claimed = await svc.claimCase({ companyId: company.id, caseId: created.case.id, actor: owner });
    await expect(svc.claimCase({ companyId: company.id, caseId: created.case.id, actor: other })).rejects.toMatchObject({
      status: 409,
      details: { code: "lease_held" },
    });
    await expect(
      svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "in_progress",
        expectedVersion: 1,
        actor: other,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "lease_held" } });

    const transitioned = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      expectedVersion: 1,
      leaseToken: claimed.leaseToken,
      actor: owner,
    });
    expect(transitioned.case.version).toBe(2);
    expect(await eventCount(created.case.id)).toBe(3);
  });

  it("expires leases on read before a new claim", async () => {
    const { company, pipeline } = await seedPipeline();
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "expired-lease",
      title: "Expired lease",
      actor: userActor,
    });
    await db.update(pipelineCases).set({
      leaseOwnerType: "user",
      leaseUserId: "old-owner",
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 5_000),
    }).where(eq(pipelineCases.id, created.case.id));

    const claimed = await svc.claimCase({ companyId: company.id, caseId: created.case.id, actor: { type: "user", userId: "new-owner" } });

    expect(claimed.leaseUserId).toBe("new-owner");
    const events = await svc.listCaseEvents(company.id, created.case.id);
    expect(events.map((event) => event.type)).toEqual(["ingested", "lease_expired", "claimed"]);
  });

  it("enforces transition edges only when enforceTransitions is enabled", async () => {
    const { company, pipeline } = await seedPipeline({ enforceTransitions: true });
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "edges",
      title: "Transition edges",
      actor: userActor,
    });

    await expect(
      svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "done",
        expectedVersion: 1,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "transition_not_allowed" } });

    await db.update(pipelines).set({ enforceTransitions: false }).where(eq(pipelines.id, pipeline.id));
    const moved = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "done",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(moved.case.terminalKind).toBe("done");
  });

  it("blocks transitions while blockers are not done", async () => {
    const { company, pipeline } = await seedPipeline();
    const blocked = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "blocked",
      title: "Blocked case",
      actor: userActor,
    });
    const blocker = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "blocker",
      title: "Blocking case",
      actor: userActor,
    });
    await svc.replaceBlockers({
      companyId: company.id,
      caseId: blocked.case.id,
      blockedByCaseIds: [blocker.case.id],
      actor: userActor,
    });

    await expect(
      svc.transitionCase({
        companyId: company.id,
        caseId: blocked.case.id,
        toStageKey: "in_progress",
        expectedVersion: 1,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "blocked" } });

    const reviewMove = await svc.transitionCase({
      companyId: company.id,
      caseId: blocked.case.id,
      toStageKey: "review",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(reviewMove.case.version).toBe(2);

    await expect(
      svc.transitionCase({
        companyId: company.id,
        caseId: blocked.case.id,
        toStageKey: "done",
        expectedVersion: 2,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "blocked" } });

    await svc.transitionCase({
      companyId: company.id,
      caseId: blocker.case.id,
      toStageKey: "done",
      expectedVersion: 1,
      actor: userActor,
    });
    const moved = await svc.transitionCase({
      companyId: company.id,
      caseId: blocked.case.id,
      toStageKey: "in_progress",
      expectedVersion: 2,
      actor: userActor,
    });
    expect(moved.case.version).toBe(3);
    const events = await svc.listCaseEvents(company.id, blocked.case.id);
    expect(events.map((event) => event.type)).toContain("blockers_resolved");
  });

  it("emits blockers_resolved once for each fresh blocker set", async () => {
    const { company, pipeline } = await seedPipeline();
    const blocked = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "blocked-again",
      title: "Blocked again",
      actor: userActor,
    });
    const firstBlocker = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "first-blocker",
      title: "First blocker",
      actor: userActor,
    });
    const secondBlocker = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "second-blocker",
      title: "Second blocker",
      actor: userActor,
    });
    const workIssue = await seedLinkedIssue({
      companyId: company.id,
      caseId: blocked.case.id,
      role: "work",
      title: "Blocked work",
    });

    await svc.replaceBlockers({
      companyId: company.id,
      caseId: blocked.case.id,
      blockedByCaseIds: [firstBlocker.case.id],
      actor: userActor,
    });
    await svc.transitionCase({
      companyId: company.id,
      caseId: firstBlocker.case.id,
      toStageKey: "done",
      expectedVersion: 1,
      actor: userActor,
    });

    await svc.replaceBlockers({
      companyId: company.id,
      caseId: blocked.case.id,
      blockedByCaseIds: [secondBlocker.case.id],
      actor: userActor,
    });
    await svc.transitionCase({
      companyId: company.id,
      caseId: secondBlocker.case.id,
      toStageKey: "done",
      expectedVersion: 1,
      actor: userActor,
    });

    const events = await svc.listCaseEvents(company.id, blocked.case.id);
    expect(events.filter((event) => event.type === "blockers_resolved")).toHaveLength(2);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, workIssue.id));
    expect(comments).toHaveLength(2);
    expect(comments.map((comment) => comment.body).join("\n")).toContain(firstBlocker.case.id);
    expect(comments.map((comment) => comment.body).join("\n")).toContain(secondBlocker.case.id);
  });

  it("keeps cancelled blockers unsatisfied until replaced", async () => {
    const { company, pipeline } = await seedPipeline();
    const blocked = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "blocked-cancelled",
      title: "Blocked case",
      actor: userActor,
    });
    const blocker = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "blocker-cancelled",
      title: "Cancelled blocker",
      actor: userActor,
    });
    await svc.replaceBlockers({
      companyId: company.id,
      caseId: blocked.case.id,
      blockedByCaseIds: [blocker.case.id],
      actor: userActor,
    });
    await svc.transitionCase({
      companyId: company.id,
      caseId: blocker.case.id,
      toStageKey: "cancelled",
      expectedVersion: 1,
      actor: userActor,
    });

    await expect(
      svc.transitionCase({
        companyId: company.id,
        caseId: blocked.case.id,
        toStageKey: "in_progress",
        expectedVersion: 1,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "blocked" } });

    await svc.replaceBlockers({ companyId: company.id, caseId: blocked.case.id, blockedByCaseIds: [], actor: userActor });
    const moved = await svc.transitionCase({
      companyId: company.id,
      caseId: blocked.case.id,
      toStageKey: "in_progress",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(moved.case.version).toBe(2);
  });

  it("posts upstream drift notices to active dependent work issues only", async () => {
    const { company, pipeline } = await seedPipeline();
    const upstream = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "draft",
      title: "Draft",
      actor: userActor,
    });
    const workDependent = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "asset-work",
      title: "Asset work",
      blockedByCaseIds: [upstream.case.id],
      actor: userActor,
    });
    const conversationDependent = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "asset-conversation",
      title: "Asset conversation",
      blockedByCaseIds: [upstream.case.id],
      actor: userActor,
    });
    const workIssue = await seedLinkedIssue({
      companyId: company.id,
      caseId: workDependent.case.id,
      role: "work",
      title: "Asset work issue",
    });
    const conversationIssue = await seedLinkedIssue({
      companyId: company.id,
      caseId: conversationDependent.case.id,
      role: "conversation",
      title: "Conversation issue",
    });

    const updated = await svc.patchCaseContent({
      companyId: company.id,
      caseId: upstream.case.id,
      title: "Draft v2",
      expectedVersion: 1,
      actor: userActor,
    });

    expect(updated.version).toBe(2);
    const workComments = await db.select().from(issueComments).where(eq(issueComments.issueId, workIssue.id));
    expect(workComments).toHaveLength(1);
    expect(workComments[0]!.authorType).toBe("system");
    expect(workComments[0]!.body).toBe(
      `Upstream case [draft](/PAP/pipelines/${pipeline.id}/cases/${upstream.case.id}) changed (v1→v2).`,
    );
    const conversationComments = await db.select().from(issueComments).where(eq(issueComments.issueId, conversationIssue.id));
    expect(conversationComments).toHaveLength(0);
  });

  it("skips upstream drift notices for terminal dependents and dependents without work issues", async () => {
    const { company, pipeline } = await seedPipeline();
    const upstream = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "source",
      title: "Source",
      actor: userActor,
    });
    const terminalDependent = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageKey: "done",
      caseKey: "terminal-dependent",
      title: "Terminal dependent",
      actor: userActor,
    });
    await svc.replaceBlockers({
      companyId: company.id,
      caseId: terminalDependent.case.id,
      blockedByCaseIds: [upstream.case.id],
      actor: userActor,
    });
    const noWorkDependent = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "no-work-dependent",
      title: "No work dependent",
      blockedByCaseIds: [upstream.case.id],
      actor: userActor,
    });
    const terminalIssue = await seedLinkedIssue({
      companyId: company.id,
      caseId: terminalDependent.case.id,
      role: "work",
      title: "Terminal work issue",
    });
    const conversationIssue = await seedLinkedIssue({
      companyId: company.id,
      caseId: noWorkDependent.case.id,
      role: "conversation",
      title: "Non-work issue",
    });

    await svc.patchCaseContent({
      companyId: company.id,
      caseId: upstream.case.id,
      summary: "Updated source",
      expectedVersion: 1,
      actor: userActor,
    });

    const terminalComments = await db.select().from(issueComments).where(eq(issueComments.issueId, terminalIssue.id));
    expect(terminalComments).toHaveLength(0);
    const conversationComments = await db.select().from(issueComments).where(eq(issueComments.issueId, conversationIssue.id));
    expect(conversationComments).toHaveLength(0);
  });

  it("does not bump versions or notify dependents on no-op content patches", async () => {
    const { company, pipeline } = await seedPipeline();
    const upstream = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "noop-source",
      title: "No-op source",
      fields: { channel: "blog" },
      actor: userActor,
    });
    const dependent = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "noop-dependent",
      title: "No-op dependent",
      blockedByCaseIds: [upstream.case.id],
      actor: userActor,
    });
    const workIssue = await seedLinkedIssue({
      companyId: company.id,
      caseId: dependent.case.id,
      role: "work",
      title: "No-op work issue",
    });
    const beforeEvents = await eventCount(upstream.case.id);

    const patched = await svc.patchCaseContent({
      companyId: company.id,
      caseId: upstream.case.id,
      title: "No-op source",
      fields: { channel: "blog" },
      expectedVersion: 1,
      actor: userActor,
    });

    expect(patched.version).toBe(1);
    expect(await eventCount(upstream.case.id)).toBe(beforeEvents);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, workIssue.id));
    expect(comments).toHaveLength(0);
  });

  it("resolves in-batch forward blocker case keys", async () => {
    const { company, pipeline } = await seedPipeline();

    const results = await svc.ingestCases({
      companyId: company.id,
      pipelineId: pipeline.id,
      items: [
        { caseKey: "tweet", title: "Tweet", blockedByCaseKeys: ["image", "post"] },
        { caseKey: "image", title: "Image" },
        { caseKey: "post", title: "Post" },
      ],
      actor: userActor,
    });

    expect(results.map((result) => result.ok)).toEqual([true, true, true]);
    const successful = results.filter((result): result is Extract<(typeof results)[number], { ok: true }> => result.ok);
    const byKey = new Map(successful
      .map((result) => [result.case.caseKey, result.case.id]));
    const blockers = await db
      .select()
      .from(pipelineCaseBlockers)
      .where(eq(pipelineCaseBlockers.caseId, byKey.get("tweet")!));
    expect(blockers.map((row) => row.blockedByCaseId).sort()).toEqual([
      byKey.get("image")!,
      byKey.get("post")!,
    ].sort());
    const events = await svc.listCaseEvents(company.id, byKey.get("tweet")!);
    const blockersEvent = events.find((event) => event.type === "blockers_set");
    expect(blockersEvent?.payload).toMatchObject({
      blockedByCaseIds: expect.arrayContaining([byKey.get("image")!, byKey.get("post")!]),
      blockedByCaseKeys: ["image", "post"],
    });
  });

  it("resolves blocker case keys against existing cases", async () => {
    const { company, pipeline } = await seedPipeline();
    const asset = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "asset",
      title: "Asset",
      actor: userActor,
    });

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "tweet",
      title: "Tweet",
      blockedByCaseKeys: ["asset"],
      actor: userActor,
    });

    const blockers = await db
      .select()
      .from(pipelineCaseBlockers)
      .where(eq(pipelineCaseBlockers.caseId, created.case.id));
    expect(blockers.map((row) => row.blockedByCaseId)).toEqual([asset.case.id]);
  });

  it("fails only unresolved blocker-key rows in batch ingest", async () => {
    const { company, pipeline } = await seedPipeline();

    const results = await svc.ingestCases({
      companyId: company.id,
      pipelineId: pipeline.id,
      items: [
        { caseKey: "ok", title: "OK" },
        { caseKey: "missing", title: "Missing", blockedByCaseKeys: ["does-not-exist"] },
        { caseKey: "after", title: "After" },
      ],
      actor: userActor,
    });

    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({
      ok: false,
      caseKey: "missing",
      error: {
        status: 404,
        details: { code: "blocker_case_key_not_found", missingCaseKeys: ["does-not-exist"] },
      },
    });
    expect(results[2]).toMatchObject({ ok: true });
    const rows = await db.select().from(pipelineCases).where(eq(pipelineCases.pipelineId, pipeline.id));
    expect(rows.map((row) => row.caseKey).sort()).toEqual(["after", "ok"]);
  });

  it("rejects blocker cycles declared by batch case keys", async () => {
    const { company, pipeline } = await seedPipeline();

    const results = await svc.ingestCases({
      companyId: company.id,
      pipelineId: pipeline.id,
      items: [
        { caseKey: "a", title: "A", blockedByCaseKeys: ["b"] },
        { caseKey: "b", title: "B", blockedByCaseKeys: ["a"] },
      ],
      actor: userActor,
    });

    expect(results).toEqual([
      expect.objectContaining({
        ok: false,
        caseKey: "a",
        error: expect.objectContaining({ status: 409, details: { code: "blocker_cycle", blockedByCaseKeys: ["b"] } }),
      }),
      expect.objectContaining({
        ok: false,
        caseKey: "b",
        error: expect.objectContaining({ status: 409, details: { code: "blocker_cycle", blockedByCaseKeys: ["a"] } }),
      }),
    ]);
    const rows = await db.select().from(pipelineCases).where(eq(pipelineCases.pipelineId, pipeline.id));
    expect(rows).toHaveLength(0);
  });

  it("rejects parent and blocker cycles and enforces parent depth", async () => {
    const { company, pipeline } = await seedPipeline();
    const a = await svc.ingestCase({ companyId: company.id, pipelineId: pipeline.id, caseKey: "a", title: "A", actor: userActor });
    const b = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "b",
      title: "B",
      parentCaseId: a.case.id,
      actor: userActor,
    });

    await expect(
      svc.patchCaseContent({
        companyId: company.id,
        caseId: a.case.id,
        parentCaseId: b.case.id,
        expectedVersion: 1,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "parent_cycle" } });

    await svc.replaceBlockers({ companyId: company.id, caseId: a.case.id, blockedByCaseIds: [b.case.id], actor: userActor });
    await expect(
      svc.replaceBlockers({ companyId: company.id, caseId: b.case.id, blockedByCaseIds: [a.case.id], actor: userActor }),
    ).rejects.toMatchObject({ status: 409, details: { code: "blocker_cycle" } });

    let parentCaseId: string | null = null;
    for (let index = 0; index < 32; index += 1) {
      const created = await svc.ingestCase({
        companyId: company.id,
        pipelineId: pipeline.id,
        caseKey: `chain-${index}`,
        title: `Chain ${index}`,
        parentCaseId,
        actor: userActor,
      });
      parentCaseId = created.case.id;
    }
    await expect(
      svc.ingestCase({
        companyId: company.id,
        pipelineId: pipeline.id,
        caseKey: "too-deep",
        title: "Too deep",
        parentCaseId,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: "parent_depth_exceeded" } });
  });

  it("rolls up a three-level tree, updates counters, and emits children_terminal once", async () => {
    const { company, pipeline } = await seedPipeline();
    const root = await svc.ingestCase({ companyId: company.id, pipelineId: pipeline.id, caseKey: "root", title: "Root", actor: userActor });
    const [linkedIssue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Root conversation",
      status: "todo",
      priority: "medium",
    }).returning();
    await db.insert(pipelineCaseIssueLinks).values({
      companyId: company.id,
      caseId: root.case.id,
      issueId: linkedIssue!.id,
      role: "conversation",
    });
    const childA = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "child-a",
      title: "Child A",
      parentCaseId: root.case.id,
      actor: userActor,
    });
    const childB = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "child-b",
      title: "Child B",
      parentCaseId: root.case.id,
      actor: userActor,
    });
    const childC = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "child-c",
      title: "Child C",
      parentCaseId: root.case.id,
      actor: userActor,
    });
    const grandA = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "grand-a",
      title: "Grand A",
      parentCaseId: childA.case.id,
      actor: userActor,
    });
    const grandB = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "grand-b",
      title: "Grand B",
      parentCaseId: childA.case.id,
      actor: userActor,
    });

    await svc.transitionCase({ companyId: company.id, caseId: childB.case.id, toStageKey: "done", expectedVersion: 1, actor: userActor });
    await svc.transitionCase({ companyId: company.id, caseId: childC.case.id, toStageKey: "done", expectedVersion: 1, actor: userActor });
    await svc.transitionCase({ companyId: company.id, caseId: grandA.case.id, toStageKey: "done", expectedVersion: 1, actor: userActor });
    await svc.transitionCase({ companyId: company.id, caseId: grandB.case.id, toStageKey: "cancelled", expectedVersion: 1, actor: userActor });
    await svc.transitionCase({ companyId: company.id, caseId: childA.case.id, toStageKey: "done", expectedVersion: 1, actor: userActor });

    expect(await svc.getCaseRollup(company.id, root.case.id)).toEqual({
      total: 5,
      done: 4,
      cancelled: 1,
      open: 0,
      complete: true,
    });
    const [freshRoot] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, root.case.id));
    const [freshChildA] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, childA.case.id));
    expect(freshRoot!.childCount).toBe(3);
    expect(freshRoot!.terminalChildCount).toBe(3);
    expect(freshChildA!.childCount).toBe(2);
    expect(freshChildA!.terminalChildCount).toBe(2);
    const rootEvents = await svc.listCaseEvents(company.id, root.case.id);
    expect(rootEvents.filter((event) => event.type === "children_terminal")).toHaveLength(1);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, linkedIssue!.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.authorType).toBe("system");
    expect(comments[0]!.body).toContain("All child cases");
  });

  it("auto-advances a parent when all descendants are terminal", async () => {
    const company = await seedCompany();
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "auto-children",
      name: "Auto children",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open", config: { autoAdvanceOnChildrenTerminal: "done" } },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const root = await svc.ingestCase({ companyId: company.id, pipelineId: pipeline.id, caseKey: "auto-root", title: "Root", actor: userActor });
    const child = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "auto-child",
      title: "Child",
      parentCaseId: root.case.id,
      actor: userActor,
    });

    await svc.transitionCase({ companyId: company.id, caseId: child.case.id, toStageKey: "done", expectedVersion: 1, actor: userActor });

    const [freshRoot] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, root.case.id));
    expect(freshRoot!.terminalKind).toBe("done");
    expect(freshRoot!.version).toBe(2);
    const rootEvents = await svc.listCaseEvents(company.id, root.case.id);
    expect(rootEvents.map((event) => event.type)).toEqual(["ingested", "children_terminal", "transitioned"]);
  });

  it("auto-advances a leased parent when child completion triggers a system transition", async () => {
    const company = await seedCompany();
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "auto-children-lease",
      name: "Auto children lease",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open", config: { autoAdvanceOnChildrenTerminal: "done" } },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const root = await svc.ingestCase({ companyId: company.id, pipelineId: pipeline.id, caseKey: "leased-root", title: "Root", actor: userActor });
    const child = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "leased-child",
      title: "Child",
      parentCaseId: root.case.id,
      actor: userActor,
    });
    await svc.claimCase({
      companyId: company.id,
      caseId: root.case.id,
      actor: { type: "user", userId: "reviewer" },
    });

    await svc.transitionCase({ companyId: company.id, caseId: child.case.id, toStageKey: "done", expectedVersion: 1, actor: userActor });

    const [freshRoot] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, root.case.id));
    expect(freshRoot!.terminalKind).toBe("done");
    expect(freshRoot!.leaseToken).toBeNull();
    const rootEvents = await svc.listCaseEvents(company.id, root.case.id);
    expect(rootEvents.map((event) => event.type)).toEqual(["ingested", "claimed", "children_terminal", "transitioned"]);
  });

  it("keeps child completion committed when parent children-terminal auto-advance is gated", async () => {
    const company = await seedCompany();
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "auto-children-blocked",
      name: "Auto children blocked",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open", config: { autoAdvanceOnChildrenTerminal: "done" } },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const root = await svc.ingestCase({ companyId: company.id, pipelineId: pipeline.id, caseKey: "blocked-root", title: "Root", actor: userActor });
    const child = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "blocked-child",
      title: "Child",
      parentCaseId: root.case.id,
      actor: userActor,
    });
    const blocker = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "open-blocker",
      title: "Open blocker",
      actor: userActor,
    });
    await svc.replaceBlockers({
      companyId: company.id,
      caseId: root.case.id,
      blockedByCaseIds: [blocker.case.id],
      actor: userActor,
    });

    await expect(
      svc.transitionCase({ companyId: company.id, caseId: child.case.id, toStageKey: "done", expectedVersion: 1, actor: userActor }),
    ).resolves.toMatchObject({ case: { terminalKind: "done" } });

    const [freshRoot] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, root.case.id));
    const [freshChild] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, child.case.id));
    expect(freshRoot!.terminalKind).toBeNull();
    expect(freshRoot!.terminalChildCount).toBe(1);
    expect(freshChild!.terminalKind).toBe("done");
    const rootEvents = await svc.listCaseEvents(company.id, root.case.id);
    expect(rootEvents.map((event) => event.type)).toEqual(["ingested", "blockers_set", "children_terminal"]);
  });

  it("records suggestion supersede, accept, and dismiss lifecycles", async () => {
    const { company, pipeline } = await seedPipeline();
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "suggest-accept",
      title: "Suggestion accept",
      actor: userActor,
    });
    const first = await svc.suggestTransition({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "review",
      rationale: "Needs review",
      actor: userActor,
    });
    const second = await svc.suggestTransition({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      rationale: "Actually draft first",
      actor: userActor,
    });
    expect(second.suggestion.id).not.toBe(first.suggestion.id);

    const accepted = await svc.resolveSuggestion({
      companyId: company.id,
      caseId: created.case.id,
      suggestionId: second.suggestion.id,
      decision: "accept",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(accepted.case.version).toBe(2);
    const acceptEvents = await svc.listCaseEvents(company.id, created.case.id);
    expect(acceptEvents.map((event) => event.type)).toEqual([
      "ingested",
      "transition_suggested",
      "transition_suggested",
      "transitioned",
      "suggestion_resolved",
    ]);

    const dismissCase = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "suggest-dismiss",
      title: "Suggestion dismiss",
      actor: userActor,
    });
    const suggestion = await svc.suggestTransition({
      companyId: company.id,
      caseId: dismissCase.case.id,
      toStageKey: "review",
      rationale: "Maybe review",
      actor: userActor,
    });
    await svc.resolveSuggestion({
      companyId: company.id,
      caseId: dismissCase.case.id,
      suggestionId: suggestion.suggestion.id,
      decision: "dismiss",
      reason: "Not ready",
      actor: userActor,
    });
    const [dismissed] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, dismissCase.case.id));
    expect(dismissed!.pendingSuggestion).toBeNull();
    expect(dismissed!.version).toBe(1);
  });

  it("writes an event for each case mutation and rejects agent mutations without run provenance", async () => {
    const { company, pipeline } = await seedPipeline();
    const agentActor = { type: "agent", agentId: randomUUID() } as PipelineActor;
    await expect(
      svc.ingestCase({
        companyId: company.id,
        pipelineId: pipeline.id,
        caseKey: "bad-agent",
        title: "Bad provenance",
        actor: agentActor,
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: "run_id_required" } });

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "events",
      title: "Events",
      actor: userActor,
    });
    expect(await eventCount(created.case.id)).toBe(1);
    await svc.patchCaseContent({ companyId: company.id, caseId: created.case.id, title: "Updated", actor: userActor });
    expect(await eventCount(created.case.id)).toBe(2);
    const claimed = await svc.claimCase({ companyId: company.id, caseId: created.case.id, actor: { type: "user", userId: "claimer" } });
    expect(await eventCount(created.case.id)).toBe(3);
    await svc.releaseCase({ companyId: company.id, caseId: created.case.id, leaseToken: claimed.leaseToken, actor: { type: "user", userId: "claimer" } });
    expect(await eventCount(created.case.id)).toBe(4);
    await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      expectedVersion: 2,
      actor: userActor,
    });
    expect(await eventCount(created.case.id)).toBe(5);
  });

  it("fires a stage-entry automation routine once and keeps crash-retry idempotent", async () => {
    const company = await seedCompany();
    const routine = await seedRoutine(company.id, "Draft on enter");
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "automation",
      name: "Automation",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: routine.id } } },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "automation",
      title: "Automation case",
      actor: userActor,
    });

    const moved = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "drafting",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(moved.automationLedger?.routineId).toBe(routine.id);
    expect(moved.automationExecution.status).toBe("succeeded");
    const ledgers = await db.select().from(pipelineAutomationExecutions);
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0]!.triggeringEventId).toBe(moved.event.id);
    expect(ledgers[0]!.executionIssueId).toBeTruthy();
    const runsAfterTransition = await db.select().from(routineRuns);
    expect(runsAfterTransition).toHaveLength(1);
    const linksAfterTransition = await db.select().from(pipelineCaseIssueLinks);
    expect(linksAfterTransition).toHaveLength(1);
    expect(linksAfterTransition[0]!.role).toBe("automation");

    const [issue] = await db.select().from(issues).where(eq(issues.id, ledgers[0]!.executionIssueId!));
    expect(issue!.description).toContain("Pipeline Case Context");
    expect(issue!.description).toContain("untrustedContent");

    const triggerEvent = await db.insert(pipelineCaseEvents).values({
      companyId: company.id,
      caseId: created.case.id,
      type: "transitioned",
      actorType: "system",
      toStageId: moved.case.stageId,
      stageGeneration: moved.case.stageGeneration,
      payload: { simulatedCrash: true },
    }).returning();
    const automationId = ledgers[0]!.automationId;
    await db.insert(pipelineAutomationExecutions).values({
      companyId: company.id,
      caseId: created.case.id,
      automationId,
      triggeringEventId: triggerEvent[0]!.id,
      routineId: routine.id,
      status: "failed",
      stageId: moved.case.stageId,
      stageGeneration: moved.case.stageGeneration,
      error: "pending_dispatch",
    });

    const firstRetry = await svc.retryAutomation({
      companyId: company.id,
      caseId: created.case.id,
      automationId,
      actor: userActor,
    });
    const secondRetry = await svc.retryAutomation({
      companyId: company.id,
      caseId: created.case.id,
      automationId,
      actor: userActor,
    });
    expect(firstRetry.status).toBe("succeeded");
    expect(secondRetry.status).toBe("succeeded");
    const runsAfterRetries = await db.select().from(routineRuns);
    expect(runsAfterRetries).toHaveLength(2);
    const crashExecutions = await db
      .select()
      .from(pipelineAutomationExecutions)
      .where(eq(pipelineAutomationExecutions.triggeringEventId, triggerEvent[0]!.id));
    expect(crashExecutions).toHaveLength(1);
    expect(crashExecutions[0]!.executionIssueId).toBeTruthy();
    const crashLinks = await db
      .select()
      .from(pipelineCaseIssueLinks)
      .where(eq(pipelineCaseIssueLinks.issueId, crashExecutions[0]!.executionIssueId!));
    expect(crashLinks).toHaveLength(1);
  });

  it("recovers a safely matchable pre-hardening pending stage-entry automation", async () => {
    const company = await seedCompany();
    const routine = await seedRoutine(company.id, "Legacy pending dispatch");
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "legacy-pending-dispatch",
      name: "Legacy pending dispatch",
      actor: userActor,
      stages: [
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: routine.id } } },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageKey: "drafting",
      caseKey: "legacy-pending-dispatch",
      title: "Legacy pending dispatch",
      actor: userActor,
    });
    const priorAttemptId = created.automationLedger!.id;
    await db.delete(pipelineCaseIssueLinks)
      .where(eq(pipelineCaseIssueLinks.automationAttemptId, priorAttemptId));
    await db.delete(pipelineAutomationExecutions)
      .where(eq(pipelineAutomationExecutions.id, priorAttemptId));
    await db.update(pipelineCaseEvents)
      .set({ stageGeneration: null })
      .where(eq(pipelineCaseEvents.id, created.event.id));
    const [legacyExecution] = await db.insert(pipelineAutomationExecutions).values({
      companyId: company.id,
      caseId: created.case.id,
      automationId: created.automationLedger!.automationId,
      triggeringEventId: created.event.id,
      routineId: routine.id,
      status: "failed",
      stageId: null,
      stageGeneration: null,
      error: "pending_dispatch",
    }).returning();

    // A legacy entry may only claim the migration baseline generation. This
    // prevents an old A-stage event from being revived after A-to-B-to-A.
    await db.update(pipelineCases)
      .set({ stageGeneration: created.case.stageGeneration + 1 })
      .where(eq(pipelineCases.id, created.case.id));
    await expect(svc.retryAutomation({
      companyId: company.id,
      caseId: created.case.id,
      automationId: legacyExecution!.automationId,
      actor: userActor,
    })).rejects.toMatchObject({ status: 404 });
    await db.update(pipelineCases)
      .set({ stageGeneration: created.case.stageGeneration })
      .where(eq(pipelineCases.id, created.case.id));

    const recovered = await svc.retryAutomation({
      companyId: company.id,
      caseId: created.case.id,
      automationId: legacyExecution!.automationId,
      actor: userActor,
    });
    expect(recovered).toMatchObject({ status: "succeeded", execution: { id: legacyExecution!.id } });
    const [persisted] = await db
      .select()
      .from(pipelineAutomationExecutions)
      .where(eq(pipelineAutomationExecutions.id, legacyExecution!.id));
    expect(persisted).toMatchObject({
      stageId: created.case.stageId,
      stageGeneration: created.case.stageGeneration,
      status: "succeeded",
      error: null,
    });
  });

  it("serializes concurrent automation ownership by case and attempt", async () => {
    const { company, pipeline } = await seedPipeline();
    const routine = await seedRoutine(company.id, "Attachment reservation");
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "attempt-reservation",
      title: "Attempt reservation",
      actor: userActor,
    });
    const [attempt] = await db.insert(pipelineAutomationExecutions).values({
      companyId: company.id,
      caseId: created.case.id,
      automationId: "attempt-reservation",
      triggeringEventId: created.event.id,
      routineId: routine.id,
      status: "failed",
      stageId: created.case.stageId,
      stageGeneration: created.case.stageGeneration,
      error: "pending_dispatch",
    }).returning();
    const [firstIssue, secondIssue] = await db.insert(issues).values([
      { companyId: company.id, title: "First returned issue", status: "todo", priority: "medium" },
      { companyId: company.id, title: "Second returned issue", status: "todo", priority: "medium" },
    ]).returning();
    const reserve = (issueId: string) => db
      .insert(pipelineCaseIssueLinks)
      .values({
        companyId: company.id,
        caseId: created.case.id,
        issueId,
        role: "automation",
        automationAttemptId: attempt!.id,
        attachmentState: "reserved",
      })
      .onConflictDoNothing()
      .returning({ issueId: pipelineCaseIssueLinks.issueId });

    const [firstReservation, secondReservation] = await Promise.all([
      reserve(firstIssue!.id),
      reserve(secondIssue!.id),
    ]);
    expect(firstReservation.length + secondReservation.length).toBe(1);
    const links = await db
      .select({ issueId: pipelineCaseIssueLinks.issueId })
      .from(pipelineCaseIssueLinks)
      .where(and(
        eq(pipelineCaseIssueLinks.caseId, created.case.id),
        eq(pipelineCaseIssueLinks.automationAttemptId, attempt!.id),
      ));
    expect(links).toHaveLength(1);
    expect([firstIssue!.id, secondIssue!.id]).toContain(links[0]!.issueId);
  });

  it("carries saved stage automation workspace context into the execution issue", async () => {
    const { company, pipeline, byKey } = await seedPipeline();
    const routineSeed = await seedRoutine(company.id, "Workspace automation seed");
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(projects).values({
      id: projectId,
      companyId: company.id,
      name: "Automation project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId: company.id,
      projectId,
      name: "Automation workspace",
      isPrimary: true,
      sharedWorkspaceKey: "pipeline-automation-primary",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId: company.id,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Automation worktree",
      status: "active",
      providerType: "git_worktree",
    });

    const updatedStage = await svc.updateStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId: byKey.get("in_progress")!.id,
      patch: {
        config: {
          automation: {
            assigneeAgentId: routineSeed.assigneeAgentId,
            instructionsBody: "Use the selected workspace.",
            projectId,
            projectWorkspaceId,
            executionWorkspaceId,
            executionWorkspacePreference: "reuse_existing",
            executionWorkspaceSettings: { mode: "isolated_workspace" },
          },
        },
      },
      actor: userActor,
    });
    expect((updatedStage.config as { onEnter?: unknown }).onEnter).toMatchObject({
      type: "run_routine",
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "workspace-context",
      title: "Workspace context case",
      actor: userActor,
    });
    const moved = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      expectedVersion: 1,
      actor: userActor,
    });

    expect(moved.automationExecution.status).toBe("succeeded");
    const executionIssueId = moved.automationExecution.status === "succeeded"
      ? moved.automationExecution.execution.executionIssueId
      : null;
    const [issue] = await db
      .select({
        projectId: issues.projectId,
        projectWorkspaceId: issues.projectWorkspaceId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, executionIssueId!));

    expect(issue).toEqual({
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
  });

  it("defaults, preserves, and interpolates pipeline automation issue title templates", async () => {
    const { company, pipeline, byKey } = await seedPipeline();
    const routineSeed = await seedRoutine(company.id, "Automation seed");
    const stageId = byKey.get("in_progress")!.id;

    const firstSave = await svc.updateStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId,
      patch: {
        config: {
          automation: {
            assigneeAgentId: routineSeed.assigneeAgentId,
            instructionsBody: "Draft from {{body}} for {{case_title}}.",
          },
        },
      },
      actor: userActor,
    });
    const firstRoutineId = (firstSave.config as { onEnter?: { routineId?: string } }).onEnter?.routineId;
    expect(firstRoutineId).toBeTruthy();
    const [defaultRoutine] = await db.select().from(routines).where(eq(routines.id, firstRoutineId!));
    expect(defaultRoutine!.title).toBe(PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE);
    expect((defaultRoutine!.variables ?? []).map((variable) => variable.name)).toEqual([
      "pipeline_name",
      "stage_name",
      "case_title",
      "body",
    ]);

    await db
      .update(routines)
      .set({ title: "Custom {{case_key}}: {{case_title}}" })
      .where(eq(routines.id, firstRoutineId!));
    await svc.updateStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId,
      patch: {
        config: {
          automation: {
            assigneeAgentId: routineSeed.assigneeAgentId,
            instructionsBody: "Updated instructions for {{case_title}}.",
          },
        },
      },
      actor: userActor,
    });
    const [customRoutine] = await db.select().from(routines).where(eq(routines.id, firstRoutineId!));
    expect(customRoutine!.title).toBe("Custom {{case_key}}: {{case_title}}");
    expect((customRoutine!.variables ?? []).map((variable) => variable.name)).toContain("case_key");

    await db
      .update(routines)
      .set({ title: "In progress automation" })
      .where(eq(routines.id, firstRoutineId!));
    await svc.updateStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId,
      patch: {
        config: {
          automation: {
            assigneeAgentId: routineSeed.assigneeAgentId,
            instructionsBody: "Runtime interpolation for {{case_title}}.",
          },
        },
      },
      actor: userActor,
    });
    const [upgradedRoutine] = await db.select().from(routines).where(eq(routines.id, firstRoutineId!));
    expect(upgradedRoutine!.title).toBe(PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE);

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "pulpit-opinion",
      title: "Pulpit opinion piece",
      body: "Agentic work should be composed, not rebuilt",
      actor: userActor,
    });
    const moved = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(moved.automationExecution.status).toBe("succeeded");
    const executionIssueId = moved.automationExecution.status === "succeeded"
      ? moved.automationExecution.execution.executionIssueId
      : null;
    const [issue] = await db
      .select({ title: issues.title })
      .from(issues)
      .where(eq(issues.id, executionIssueId!));
    expect(issue!.title).toBe("Content / In progress: Pulpit opinion piece");
  });

  it("rejects cross-company stage automation routines at save and execution", async () => {
    const company = await seedCompany();
    const otherCompany = await seedCompany();
    const routine = await seedRoutine(company.id, "Own routine");
    const otherRoutine = await seedRoutine(otherCompany.id, "Other routine");

    await expect(svc.createPipeline({
      companyId: company.id,
      key: "bad-automation",
      name: "Bad automation",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: otherRoutine.id } } },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    })).rejects.toMatchObject({ status: 422, details: { code: "validation" } });

    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "execution-automation",
      name: "Execution automation",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: routine.id } } },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "cross-company-execution",
      title: "Cross-company execution",
      actor: userActor,
    });
    const moved = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "drafting",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(moved.automationExecution.status).toBe("succeeded");

    const [triggerEvent] = await db.insert(pipelineCaseEvents).values({
      companyId: company.id,
      caseId: created.case.id,
      type: "transitioned",
      actorType: "system",
      toStageId: moved.case.stageId,
      stageGeneration: moved.case.stageGeneration,
      payload: { crossCompanyRoutine: true },
    }).returning();
    const [badExecution] = await db.insert(pipelineAutomationExecutions).values({
      companyId: company.id,
      caseId: created.case.id,
      automationId: moved.automationLedger!.automationId,
      triggeringEventId: triggerEvent!.id,
      routineId: otherRoutine.id,
      status: "failed",
      stageId: moved.case.stageId,
      stageGeneration: moved.case.stageGeneration,
      error: "pending_dispatch",
    }).returning();

    const retried = await svc.retryAutomation({
      companyId: company.id,
      caseId: created.case.id,
      automationId: moved.automationLedger!.automationId,
      actor: userActor,
    });
    expect(retried.status).toBe("failed");
    const [execution] = await db
      .select()
      .from(pipelineAutomationExecutions)
      .where(eq(pipelineAutomationExecutions.id, badExecution!.id));
    expect(execution!.error).toContain("same company");
    const events = await svc.listCaseEvents(company.id, created.case.id);
    expect(events.filter((event) => event.type === "automation_failed")).toHaveLength(1);
  });

  it("auto-advances after retry creates a fresh terminal child rollup", async () => {
    const company = await seedCompany();
    const routine = await seedRoutine(company.id, "Retry child cleanup");
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "retry-child-cleanup",
      name: "Retry child cleanup",
      actor: userActor,
      stages: [
        {
          key: "build",
          name: "Build",
          kind: "working",
          config: {
            autoAdvanceOnChildrenTerminal: "review",
            onEnter: {
              type: "run_routine",
              id: "build-children",
              routineId: routine.id,
            },
          },
        },
        { key: "review", name: "Review", kind: "working" },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const parent = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "parent",
      title: "Parent",
      actor: userActor,
    });
    const [event] = await db.insert(pipelineCaseEvents).values({
      companyId: company.id,
      caseId: parent.case.id,
      type: "transitioned",
      actorType: "system",
      toStageId: parent.case.stageId,
      stageGeneration: parent.case.stageGeneration,
      payload: { test: true },
    }).returning();
    const [attempt] = await db.insert(pipelineAutomationExecutions).values({
      companyId: company.id,
      caseId: parent.case.id,
      automationId: "build-children",
      triggeringEventId: event!.id,
      routineId: routine.id,
      status: "failed",
      stageId: parent.case.stageId,
      stageGeneration: parent.case.stageGeneration,
      error: "boom",
    }).returning();
    const child = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "child",
      title: "Child",
      parentCaseId: parent.case.id,
      actor: userActor,
    });
    await db
      .update(pipelineCases)
      .set({ automationAttemptId: attempt!.id })
      .where(eq(pipelineCases.id, child.case.id));
    await svc.transitionCase({
      companyId: company.id,
      caseId: child.case.id,
      toStageKey: "done",
      expectedVersion: child.case.version,
      actor: userActor,
    });
    const [reviewingParent] = await db
      .select({ version: pipelineCases.version, stageKey: pipelineStages.key })
      .from(pipelineCases)
      .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
      .where(eq(pipelineCases.id, parent.case.id));
    expect(reviewingParent!.stageKey).toBe("review");

    const retry = await svc.retryStageAutomation({
      companyId: company.id,
      caseId: parent.case.id,
      scope: "previous_stage",
      targetStageId: event!.toStageId,
      expectedVersion: reviewingParent!.version,
      cleanup: {
        retireDirectChildren: true,
        retireDescendants: true,
        cancelLinkedAutomationIssues: true,
      },
      actor: userActor,
    });
    const retryChild = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "retry-child",
      title: "Retry child",
      parentCaseId: parent.case.id,
      actor: userActor,
    });
    await db
      .update(pipelineCases)
      .set({ automationAttemptId: retry.automationLedger.id })
      .where(eq(pipelineCases.id, retryChild.case.id));
    await svc.transitionCase({
      companyId: company.id,
      caseId: retryChild.case.id,
      toStageKey: "done",
      expectedVersion: retryChild.case.version,
      actor: userActor,
    });

    const [freshParent] = await db
      .select({ childCount: pipelineCases.childCount, terminalChildCount: pipelineCases.terminalChildCount, stageKey: pipelineStages.key })
      .from(pipelineCases)
      .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
      .where(eq(pipelineCases.id, parent.case.id));
    const [freshChild] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, child.case.id));
    expect(freshParent!.childCount).toBe(2);
    expect(freshParent!.terminalChildCount).toBe(2);
    expect(freshParent!.stageKey).toBe("review");
    expect(freshChild!.terminalKind).toBe("cancelled");
    expect(freshChild!.retiredReason).toBe("automation_retry");
    const events = await svc.listCaseEvents(company.id, parent.case.id);
    expect(events.filter((pipelineEvent) => pipelineEvent.type === "children_terminal")).toHaveLength(2);
  });

  it("updates intermediate terminal counts when retry retires descendants only", async () => {
    const company = await seedCompany();
    const routine = await seedRoutine(company.id, "Retry descendants only");
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "retry-descendants-only",
      name: "Retry descendants only",
      actor: userActor,
      stages: [
        {
          key: "build",
          name: "Build",
          kind: "working",
          config: {
            onEnter: {
              type: "run_routine",
              id: "build-descendants",
              routineId: routine.id,
            },
          },
        },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const parent = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "descendants-parent",
      title: "Descendants parent",
      actor: userActor,
    });
    const [event] = await db.insert(pipelineCaseEvents).values({
      companyId: company.id,
      caseId: parent.case.id,
      type: "transitioned",
      actorType: "system",
      toStageId: parent.case.stageId,
      stageGeneration: parent.case.stageGeneration,
      payload: { test: true },
    }).returning();
    const [attempt] = await db.insert(pipelineAutomationExecutions).values({
      companyId: company.id,
      caseId: parent.case.id,
      automationId: "build-descendants",
      triggeringEventId: event!.id,
      routineId: routine.id,
      status: "failed",
      stageId: parent.case.stageId,
      stageGeneration: parent.case.stageGeneration,
      error: "boom",
    }).returning();
    const child = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "descendants-child",
      title: "Descendants child",
      parentCaseId: parent.case.id,
      actor: userActor,
    });
    await db
      .update(pipelineCases)
      .set({ automationAttemptId: attempt!.id })
      .where(eq(pipelineCases.id, child.case.id));
    const grandchild = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "descendants-grandchild",
      title: "Descendants grandchild",
      parentCaseId: child.case.id,
      actor: userActor,
    });

    await svc.retryStageAutomation({
      companyId: company.id,
      caseId: parent.case.id,
      scope: "current_stage",
      expectedVersion: parent.case.version,
      cleanup: {
        retireDirectChildren: false,
        retireDescendants: true,
        cancelLinkedAutomationIssues: false,
      },
      actor: userActor,
    });

    const [freshParent] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, parent.case.id));
    const [freshChild] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, child.case.id));
    const [freshGrandchild] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, grandchild.case.id));
    expect(freshParent!.terminalChildCount).toBe(0);
    expect(freshChild!.terminalKind).toBeNull();
    expect(freshChild!.terminalChildCount).toBe(1);
    expect(freshGrandchild!.terminalKind).toBe("cancelled");
    expect(freshGrandchild!.retiredReason).toBe("automation_retry");
  });

  it("retires an exited stage generation, cancels its wakes, and interrupts its running owner", async () => {
    const company = await seedCompany();
    const routine = await seedRoutine(company.id, "Exit generation");
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "exit-generation",
      name: "Exit generation",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: routine.id } } },
        { key: "review", name: "Review", kind: "working" },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "exit-generation",
      title: "Exit generation",
      actor: userActor,
    });
    const entered = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "drafting",
      expectedVersion: created.case.version,
      actor: userActor,
    });
    const issueId = entered.automationExecution.status === "succeeded"
      ? entered.automationExecution.execution.executionIssueId!
      : "";
    const runningRunId = randomUUID();
    const queuedRunId = randomUUID();
    const queuedWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: queuedWakeId,
      companyId: company.id,
      agentId: routine.assigneeAgentId!,
      source: "assignment",
      status: "queued",
    });
    await db.insert(heartbeatRuns).values([
      {
        id: runningRunId,
        companyId: company.id,
        agentId: routine.assigneeAgentId!,
        status: "running",
        invocationSource: "assignment",
        contextSnapshot: { issueId },
      },
      {
        id: queuedRunId,
        companyId: company.id,
        agentId: routine.assigneeAgentId!,
        status: "queued",
        invocationSource: "assignment",
        wakeupRequestId: queuedWakeId,
        contextSnapshot: { issueId },
      },
    ]);
    await db.update(issues).set({
      status: "in_progress",
      executionRunId: runningRunId,
      checkoutRunId: runningRunId,
    }).where(eq(issues.id, issueId));
    await db.insert(agentWakeupRequests).values({
      companyId: company.id,
      agentId: routine.assigneeAgentId!,
      source: "comment",
      status: "deferred_issue_execution",
      payload: { issueId },
    });

    await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "review",
      expectedVersion: entered.case.version,
      actor: userActor,
    });

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [link] = await db.select().from(pipelineCaseIssueLinks).where(eq(pipelineCaseIssueLinks.issueId, issueId));
    const runs = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, company.id),
      sql`${heartbeatRuns.id} in (${runningRunId}::uuid, ${queuedRunId}::uuid)`,
    ));
    const [queuedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queuedWakeId));
    const [deferredWake] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.status, "cancelled"),
      sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
    ));

    expect(issue).toMatchObject({ status: "cancelled", executionRunId: null, checkoutRunId: null });
    expect(link).toMatchObject({ retiredReason: "stage_exited" });
    expect(runs.map((run) => ({ id: run.id, status: run.status, errorCode: run.errorCode }))).toEqual(expect.arrayContaining([
      { id: runningRunId, status: "cancelled", errorCode: "pipeline_stage_exited" },
      { id: queuedRunId, status: "cancelled", errorCode: "pipeline_stage_exited" },
    ]));
    expect(queuedWake).toMatchObject({ status: "skipped" });
    expect(deferredWake).toMatchObject({ status: "cancelled" });
    expect(cancelledRunIds).toContain(runningRunId);
  });

  it("keeps a coalesced automation issue alive until its final case owner exits", async () => {
    const company = await seedCompany();
    const routine = await seedRoutine(company.id, "Coalesced owner");
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "coalesced-owner",
      name: "Coalesced owner",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: routine.id } } },
        { key: "review", name: "Review", kind: "working" },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const entered = [] as Array<Awaited<ReturnType<typeof svc.transitionCase>>>;
    for (const caseKey of ["first-owner", "second-owner"]) {
      const created = await svc.ingestCase({ companyId: company.id, pipelineId: pipeline.id, caseKey, title: caseKey, actor: userActor });
      entered.push(await svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "drafting",
        expectedVersion: created.case.version,
        actor: userActor,
      }));
    }
    const sharedIssueId = entered[0]!.automationExecution.status === "succeeded"
      ? entered[0]!.automationExecution.execution.executionIssueId!
      : "";
    const supersededIssueId = entered[1]!.automationExecution.status === "succeeded"
      ? entered[1]!.automationExecution.execution.executionIssueId!
      : "";
    const secondAttemptId = entered[1]!.automationLedger!.id;
    await db.update(pipelineAutomationExecutions)
      .set({ executionIssueId: sharedIssueId })
      .where(eq(pipelineAutomationExecutions.id, secondAttemptId));
    await db.update(pipelineCaseIssueLinks)
      .set({ issueId: sharedIssueId })
      .where(eq(pipelineCaseIssueLinks.automationAttemptId, secondAttemptId));
    await db.delete(issues).where(eq(issues.id, supersededIssueId));

    await svc.transitionCase({
      companyId: company.id,
      caseId: entered[0]!.case.id,
      toStageKey: "review",
      expectedVersion: entered[0]!.case.version,
      actor: userActor,
    });
    let [sharedIssue] = await db.select().from(issues).where(eq(issues.id, sharedIssueId));
    let links = await db.select().from(pipelineCaseIssueLinks).where(eq(pipelineCaseIssueLinks.issueId, sharedIssueId));
    expect(sharedIssue!.status).toBe("todo");
    expect(links.filter((link) => link.retiredAt === null)).toHaveLength(1);

    await svc.transitionCase({
      companyId: company.id,
      caseId: entered[1]!.case.id,
      toStageKey: "review",
      expectedVersion: entered[1]!.case.version,
      actor: userActor,
    });
    [sharedIssue] = await db.select().from(issues).where(eq(issues.id, sharedIssueId));
    links = await db.select().from(pipelineCaseIssueLinks).where(eq(pipelineCaseIssueLinks.issueId, sharedIssueId));
    expect(sharedIssue!.status).toBe("cancelled");
    expect(links.every((link) => link.retiredReason === "stage_exited")).toBe(true);
  });

  it("uses the stage-entry generation instead of ordinary case-version drift", async () => {
    const company = await seedCompany();
    const routine = await seedRoutine(company.id, "Delayed generation");
    let releaseWake!: () => void;
    let markWakeStarted!: () => void;
    const wakeStarted = new Promise<void>((resolve) => { markWakeStarted = resolve; });
    const wakeReleased = new Promise<void>((resolve) => { releaseWake = resolve; });
    const delayedSvc = pipelineService(db, {
      heartbeat: {
        wakeup: async () => {
          markWakeStarted();
          await wakeReleased;
          return null;
        },
      },
    });
    const pipeline = await delayedSvc.createPipeline({
      companyId: company.id,
      key: "delayed-generation",
      name: "Delayed generation",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: routine.id } } },
        { key: "review", name: "Review", kind: "working" },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const created = await delayedSvc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "delayed-generation",
      title: "Delayed generation",
      actor: userActor,
    });
    const entering = delayedSvc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "drafting",
      expectedVersion: created.case.version,
      actor: userActor,
    });
    await wakeStarted;
    const [draftingCase] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, created.case.id));
    await delayedSvc.patchCaseContent({
      companyId: company.id,
      caseId: created.case.id,
      summary: "An edit during routine dispatch is not a stage exit",
      expectedVersion: draftingCase!.version,
      actor: userActor,
    });
    releaseWake();
    const entered = await entering;
    const issueId = entered.automationExecution.status === "succeeded"
      ? entered.automationExecution.execution.executionIssueId!
      : "";
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [link] = await db.select().from(pipelineCaseIssueLinks).where(eq(pipelineCaseIssueLinks.issueId, issueId));
    expect(issue!.status).toBe("todo");
    expect(link).toMatchObject({ retiredAt: null, retiredReason: null });
  });

  it("keeps a current-stage rerun attached to its attempt-bearing generation", async () => {
    const company = await seedCompany();
    const routine = await seedRoutine(company.id, "Rerun generation");
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "rerun-generation",
      name: "Rerun generation",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: routine.id } } },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const created = await svc.ingestCase({ companyId: company.id, pipelineId: pipeline.id, caseKey: "rerun-generation", title: "Rerun generation", actor: userActor });
    const entered = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "drafting",
      expectedVersion: created.case.version,
      actor: userActor,
    });
    const rerun = await svc.rerunCurrentStageAutomation({ companyId: company.id, caseId: created.case.id, actor: userActor });
    const [link] = await db.select().from(pipelineCaseIssueLinks)
      .where(eq(pipelineCaseIssueLinks.automationAttemptId, rerun.automationLedger.id));
    const [issue] = await db.select().from(issues).where(eq(issues.id, link!.issueId));
    const events = await svc.listCaseEvents(company.id, created.case.id);
    expect(entered.automationExecution.status).toBe("succeeded");
    expect(link).toMatchObject({ retiredAt: null, retiredReason: null });
    expect(["done", "cancelled"]).not.toContain(issue!.status);
    expect(events.some((event) => event.type === "automation_retry_dispatched" &&
      (event.payload as Record<string, unknown>).retryAttemptId === rerun.automationLedger.id)).toBe(true);
  });

  it("retires a delayed attachment when the case leaves its originating stage", async () => {
    const company = await seedCompany();
    const routine = await seedRoutine(company.id, "Delayed exit");
    let releaseWake!: () => void;
    let markWakeStarted!: () => void;
    const wakeStarted = new Promise<void>((resolve) => { markWakeStarted = resolve; });
    const wakeReleased = new Promise<void>((resolve) => { releaseWake = resolve; });
    const delayedSvc = pipelineService(db, {
      heartbeat: {
        wakeup: async () => {
          markWakeStarted();
          await wakeReleased;
          return null;
        },
      },
    });
    const pipeline = await delayedSvc.createPipeline({
      companyId: company.id,
      key: "delayed-exit",
      name: "Delayed exit",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: routine.id } } },
        { key: "review", name: "Review", kind: "working" },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const created = await delayedSvc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "delayed-exit",
      title: "Delayed exit",
      actor: userActor,
    });
    const entering = delayedSvc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "drafting",
      expectedVersion: created.case.version,
      actor: userActor,
    });
    await wakeStarted;
    const [draftingCase] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, created.case.id));
    await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "review",
      expectedVersion: draftingCase!.version,
      actor: userActor,
    });
    releaseWake();
    const entered = await entering;
    const issueId = entered.automationExecution.status === "succeeded"
      ? entered.automationExecution.execution.executionIssueId!
      : "";
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [link] = await db.select().from(pipelineCaseIssueLinks).where(eq(pipelineCaseIssueLinks.issueId, issueId));
    expect(issue!.status).toBe("cancelled");
    expect(link).toMatchObject({ retiredReason: "stage_exited" });
  });

  it("retires the link but preserves a repurposed automation issue", async () => {
    const company = await seedCompany();
    const routine = await seedRoutine(company.id, "Repurposed issue");
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "repurposed-issue",
      name: "Repurposed issue",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: routine.id } } },
        { key: "review", name: "Review", kind: "working" },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const created = await svc.ingestCase({ companyId: company.id, pipelineId: pipeline.id, caseKey: "repurposed-issue", title: "Repurposed issue", actor: userActor });
    const entered = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "drafting",
      expectedVersion: created.case.version,
      actor: userActor,
    });
    const issueId = entered.automationExecution.status === "succeeded"
      ? entered.automationExecution.execution.executionIssueId!
      : "";
    await db.update(issues).set({ originKind: "manual", originId: null }).where(eq(issues.id, issueId));
    await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "review",
      expectedVersion: entered.case.version,
      actor: userActor,
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [link] = await db.select().from(pipelineCaseIssueLinks).where(eq(pipelineCaseIssueLinks.issueId, issueId));
    expect(issue!.status).toBe("todo");
    expect(link).toMatchObject({ retiredReason: "stage_exited" });
  });

  // BLO-19771: the live failure was a `drafting` automation issue that stayed
  // `in_progress` after its case ran on to a terminal stage, waking the assigned
  // agent 91 minutes later. Both stages are asserted: the one the case merely
  // passed through, and the one it was sitting in when it went terminal.
  it("retires stage automation issues from every stage once the case reaches a terminal stage", async () => {
    const company = await seedCompany();
    const draftingRoutine = await seedRoutine(company.id, "Terminal drafting");
    const assetsRoutine = await seedRoutine(company.id, "Terminal assets");
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "terminal-retirement",
      name: "Terminal retirement",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: draftingRoutine.id } } },
        { key: "assets", name: "Assets", kind: "working", config: { onEnter: { type: "run_routine", routineId: assetsRoutine.id } } },
        { key: "published", name: "Published", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const created = await svc.ingestCase({ companyId: company.id, pipelineId: pipeline.id, caseKey: "blog-post", title: "Blog post", actor: userActor });
    const drafting = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "drafting",
      expectedVersion: created.case.version,
      actor: userActor,
    });
    const draftingIssueId = drafting.automationExecution.status === "succeeded"
      ? drafting.automationExecution.execution.executionIssueId!
      : "";
    const assets = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "assets",
      expectedVersion: drafting.case.version,
      actor: userActor,
    });
    const assetsIssueId = assets.automationExecution.status === "succeeded"
      ? assets.automationExecution.execution.executionIssueId!
      : "";
    expect(draftingIssueId).not.toBe("");
    expect(assetsIssueId).not.toBe("");
    expect(assetsIssueId).not.toBe(draftingIssueId);

    const terminal = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "published",
      expectedVersion: assets.case.version,
      actor: userActor,
    });
    expect(terminal.case.terminalKind).toBe("done");

    // The stage the case passed through, and the stage it went terminal from.
    for (const issueId of [draftingIssueId, assetsIssueId]) {
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      const [link] = await db.select().from(pipelineCaseIssueLinks).where(eq(pipelineCaseIssueLinks.issueId, issueId));
      expect(issue!.status).toBe("cancelled");
      expect(link!.retiredAt).not.toBeNull();
      expect(link).toMatchObject({ retiredReason: "stage_exited" });
    }
  });

  it("retires the automation link without cancelling an issue that has live non-automation ownership", async () => {
    const company = await seedCompany();
    const routine = await seedRoutine(company.id, "Shared ownership");
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "shared-ownership",
      name: "Shared ownership",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: routine.id } } },
        { key: "review", name: "Review", kind: "working" },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "shared-ownership",
      title: "Shared ownership",
      actor: userActor,
    });
    const entered = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "drafting",
      expectedVersion: created.case.version,
      actor: userActor,
    });
    const issueId = entered.automationExecution.status === "succeeded"
      ? entered.automationExecution.execution.executionIssueId!
      : "";
    await db.insert(pipelineCaseIssueLinks).values({
      companyId: company.id,
      caseId: created.case.id,
      issueId,
      role: "work",
    });

    await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "review",
      expectedVersion: entered.case.version,
      actor: userActor,
    });

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const links = await db.select().from(pipelineCaseIssueLinks).where(eq(pipelineCaseIssueLinks.issueId, issueId));
    expect(issue).toMatchObject({ status: "todo", cancelledAt: null });
    expect(links.find((link) => link.role === "automation")).toMatchObject({ retiredReason: "stage_exited" });
    expect(links.find((link) => link.role === "work")).toMatchObject({ retiredAt: null, attachmentState: "attached" });
  });

  it("excludes reserved and retired descendant automation links from active-work rollups", async () => {
    const { company, pipeline, byKey } = await seedPipeline();
    const root = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageKey: "in_progress",
      caseKey: "active-work-root",
      title: "Active work root",
      actor: userActor,
    });
    const child = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageKey: "in_progress",
      caseKey: "active-work-child",
      title: "Active work child",
      parentCaseId: root.case.id,
      actor: userActor,
    });
    expect(byKey.get("in_progress")).toBeDefined();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Active work rollup agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Reserved automation work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agent!.id,
    }).returning();
    const [link] = await db.insert(pipelineCaseIssueLinks).values({
      companyId: company.id,
      caseId: child.case.id,
      issueId: issue!.id,
      role: "automation",
      attachmentState: "reserved",
    }).returning();

    const descendantCounts = () => loadDescendantActiveWorkCountsForCases(db, company.id, [root.case.id]);
    const pipelineCounts = () => loadPipelineDescendantActiveWorkCounts(db, company.id, [pipeline.id]);
    expect((await descendantCounts()).get(root.case.id)).toBe(0);
    expect((await pipelineCounts()).get(pipeline.id)).toBe(0);

    await db.update(pipelineCaseIssueLinks)
      .set({ attachmentState: "attached" })
      .where(eq(pipelineCaseIssueLinks.id, link!.id));
    expect((await descendantCounts()).get(root.case.id)).toBe(1);
    expect((await pipelineCounts()).get(pipeline.id)).toBe(1);

    await db.update(pipelineCaseIssueLinks)
      .set({ retiredAt: new Date(), retiredReason: "stage_exited" })
      .where(eq(pipelineCaseIssueLinks.id, link!.id));
    expect((await descendantCounts()).get(root.case.id)).toBe(0);
    expect((await pipelineCounts()).get(pipeline.id)).toBe(0);
  });

  it("uses last-owner retirement during a previous-stage retry", async () => {
    const company = await seedCompany();
    const routine = await seedRoutine(company.id, "Previous retry owner");
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "previous-retry-owner",
      name: "Previous retry owner",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: routine.id } } },
        { key: "review", name: "Review", kind: "working" },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const entered = [] as Array<Awaited<ReturnType<typeof svc.transitionCase>>>;
    for (const caseKey of ["retrying-owner", "remaining-owner"]) {
      const created = await svc.ingestCase({ companyId: company.id, pipelineId: pipeline.id, caseKey, title: caseKey, actor: userActor });
      entered.push(await svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "drafting",
        expectedVersion: created.case.version,
        actor: userActor,
      }));
    }
    const retryingAttemptId = entered[0]!.automationLedger!.id;
    const remainingAttemptId = entered[1]!.automationLedger!.id;
    const sharedIssueId = entered[0]!.automationExecution.status === "succeeded"
      ? entered[0]!.automationExecution.execution.executionIssueId!
      : "";
    const supersededIssueId = entered[1]!.automationExecution.status === "succeeded"
      ? entered[1]!.automationExecution.execution.executionIssueId!
      : "";
    await db.update(pipelineAutomationExecutions)
      .set({ executionIssueId: sharedIssueId })
      .where(eq(pipelineAutomationExecutions.id, remainingAttemptId));
    await db.update(pipelineCaseIssueLinks)
      .set({ issueId: sharedIssueId })
      .where(eq(pipelineCaseIssueLinks.automationAttemptId, remainingAttemptId));
    await db.delete(issues).where(eq(issues.id, supersededIssueId));

    const reviewed = await svc.transitionCase({
      companyId: company.id,
      caseId: entered[0]!.case.id,
      toStageKey: "review",
      expectedVersion: entered[0]!.case.version,
      actor: userActor,
    });
    // Reconstruct the previous attempt as an active retry-cleanup candidate;
    // the second case remains the shared issue's live owner.
    await db.update(pipelineCaseIssueLinks)
      .set({ retiredAt: null, retiredReason: null })
      .where(eq(pipelineCaseIssueLinks.automationAttemptId, retryingAttemptId));
    await svc.retryStageAutomation({
      companyId: company.id,
      caseId: entered[0]!.case.id,
      scope: "previous_stage",
      targetStageId: entered[0]!.case.stageId,
      expectedVersion: reviewed.case.version,
      cleanup: {
        retireDirectChildren: true,
        retireDescendants: true,
        cancelLinkedAutomationIssues: true,
      },
      actor: userActor,
    });
    const [sharedIssue] = await db.select().from(issues).where(eq(issues.id, sharedIssueId));
    const links = await db.select().from(pipelineCaseIssueLinks).where(eq(pipelineCaseIssueLinks.issueId, sharedIssueId));
    expect(["done", "cancelled"]).not.toContain(sharedIssue!.status);
    expect(links.find((link) => link.automationAttemptId === retryingAttemptId)).toMatchObject({ retiredReason: "stage_exited" });
    expect(links.find((link) => link.automationAttemptId === remainingAttemptId)).toMatchObject({ retiredAt: null, retiredReason: null });
  });

  it("uses the persisted generation when an old A dispatch returns after A-to-B-to-A re-entry", async () => {
    const company = await seedCompany();
    const routine = await seedRoutine(company.id, "A re-entry generation");
    let releaseFirstDispatch!: () => void;
    let markFirstDispatchStarted!: () => void;
    const firstDispatchStarted = new Promise<void>((resolve) => { markFirstDispatchStarted = resolve; });
    const releaseFirstDispatchPromise = new Promise<void>((resolve) => { releaseFirstDispatch = resolve; });
    const reentrySvc = pipelineService(db, {
      heartbeat: { wakeup: async () => null },
      testHooks: {
        afterStageAutomationRoutine: async (dispatch) => {
          if (dispatch.stageGeneration === 2) {
            markFirstDispatchStarted();
            await releaseFirstDispatchPromise;
          }
        },
      },
    });
    const pipeline = await reentrySvc.createPipeline({
      companyId: company.id,
      key: "a-b-a-generation",
      name: "A B A generation",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "a", name: "A", kind: "working", config: { onEnter: { type: "run_routine", routineId: routine.id } } },
        { key: "b", name: "B", kind: "working" },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const created = await reentrySvc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "a-b-a-generation",
      title: "A B A generation",
      actor: userActor,
    });

    const firstEntry = reentrySvc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "a",
      expectedVersion: created.case.version,
      actor: userActor,
    });
    await firstDispatchStarted;

    const [atFirstA] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, created.case.id));
    const enteredB = await reentrySvc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "b",
      expectedVersion: atFirstA!.version,
      actor: userActor,
    });
    const reenteredA = await reentrySvc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "a",
      expectedVersion: enteredB.case.version,
      actor: userActor,
    });
    expect(reenteredA.case.stageGeneration).toBe(4);

    const attempts = await db
      .select()
      .from(pipelineAutomationExecutions)
      .where(eq(pipelineAutomationExecutions.caseId, created.case.id));
    const oldAttempt = attempts.find((attempt) => attempt.stageGeneration === 2);
    const currentAttempt = attempts.find((attempt) => attempt.stageGeneration === 4);
    if (!oldAttempt || !currentAttempt) throw new Error("Expected both A-stage generations to be recorded");

    // Deliberately make the stale attempt look newer than the current one.
    // A timestamp or random-event-id heuristic would select the wrong A entry;
    // the attachment check must use the persisted stage id + generation.
    await db
      .update(pipelineAutomationExecutions)
      .set({ createdAt: new Date("2030-01-01T00:00:00.000Z") })
      .where(eq(pipelineAutomationExecutions.id, oldAttempt.id));
    await db
      .update(pipelineAutomationExecutions)
      .set({ createdAt: new Date("2000-01-01T00:00:00.000Z") })
      .where(eq(pipelineAutomationExecutions.id, currentAttempt.id));

    releaseFirstDispatch();
    await firstEntry;

    const [currentCase] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, created.case.id));
    const [oldLink] = await db
      .select()
      .from(pipelineCaseIssueLinks)
      .where(eq(pipelineCaseIssueLinks.automationAttemptId, oldAttempt.id));
    const [currentLink] = await db
      .select()
      .from(pipelineCaseIssueLinks)
      .where(eq(pipelineCaseIssueLinks.automationAttemptId, currentAttempt.id));
    const [oldIssue] = await db.select().from(issues).where(eq(issues.id, oldLink!.issueId));
    const [currentIssue] = await db.select().from(issues).where(eq(issues.id, currentLink!.issueId));

    expect(currentCase?.stageGeneration).toBe(4);
    expect(oldLink).toMatchObject({ retiredReason: "stage_exited" });
    expect(oldIssue?.status).toBe("cancelled");
    expect(currentLink).toMatchObject({ attachmentState: "attached", retiredAt: null, retiredReason: null });
    expect(["done", "cancelled"]).not.toContain(currentIssue?.status);

    const retried = await reentrySvc.retryAutomation({
      companyId: company.id,
      caseId: created.case.id,
      automationId: currentAttempt.automationId,
      actor: userActor,
    });
    expect(retried).toMatchObject({ status: "succeeded", execution: { id: currentAttempt.id } });
  });

  it("keeps a reserved coalesced owner visible while another owner exits", async () => {
    const company = await seedCompany();
    const routine = await seedRoutine(company.id, "Reserved coalesced owner");
    let firstCaseId = "";
    let sharedIssueId = "";
    let markSecondReserved!: () => void;
    let releaseSecondReservation!: () => void;
    const secondReserved = new Promise<void>((resolve) => { markSecondReserved = resolve; });
    const releaseSecondReservationPromise = new Promise<void>((resolve) => { releaseSecondReservation = resolve; });
    const raceSvc = pipelineService(db, {
      heartbeat: { wakeup: async () => null },
      testHooks: {
        afterStageAutomationReservation: async (reservation) => {
          if (reservation.caseId === firstCaseId) return;
          if (!sharedIssueId) throw new Error("First coalesced owner was not attached before the second reservation");
          // Model a routine runner that coalesces the second execution onto the
          // first issue immediately after its reservation commits. Hold before
          // attachment so the first case can perform a last-owner retirement.
          await db
            .update(pipelineAutomationExecutions)
            .set({ executionIssueId: sharedIssueId })
            .where(eq(pipelineAutomationExecutions.id, reservation.executionId));
          await db
            .update(pipelineCaseIssueLinks)
            .set({ issueId: sharedIssueId })
            .where(eq(pipelineCaseIssueLinks.automationAttemptId, reservation.executionId));
          markSecondReserved();
          await releaseSecondReservationPromise;
        },
      },
    });
    const pipeline = await raceSvc.createPipeline({
      companyId: company.id,
      key: "reserved-coalesced-owner",
      name: "Reserved coalesced owner",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: routine.id } } },
        { key: "review", name: "Review", kind: "working" },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const firstCreated = await raceSvc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "reserved-first-owner",
      title: "Reserved first owner",
      actor: userActor,
    });
    firstCaseId = firstCreated.case.id;
    const firstEntered = await raceSvc.transitionCase({
      companyId: company.id,
      caseId: firstCreated.case.id,
      toStageKey: "drafting",
      expectedVersion: firstCreated.case.version,
      actor: userActor,
    });
    if (firstEntered.automationExecution.status !== "succeeded") {
      throw new Error("Expected first automation owner to attach");
    }
    sharedIssueId = firstEntered.automationExecution.execution.executionIssueId!;

    const secondCreated = await raceSvc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "reserved-second-owner",
      title: "Reserved second owner",
      actor: userActor,
    });
    const secondEntry = raceSvc.transitionCase({
      companyId: company.id,
      caseId: secondCreated.case.id,
      toStageKey: "drafting",
      expectedVersion: secondCreated.case.version,
      actor: userActor,
    });
    await secondReserved;

    const [reservedLink] = await db
      .select()
      .from(pipelineCaseIssueLinks)
      .where(and(
        eq(pipelineCaseIssueLinks.caseId, secondCreated.case.id),
        eq(pipelineCaseIssueLinks.issueId, sharedIssueId),
      ));
    expect(reservedLink).toMatchObject({ attachmentState: "reserved", retiredAt: null });

    await raceSvc.transitionCase({
      companyId: company.id,
      caseId: firstCreated.case.id,
      toStageKey: "review",
      expectedVersion: firstEntered.case.version,
      actor: userActor,
    });
    const [sharedAfterFirstExit] = await db.select().from(issues).where(eq(issues.id, sharedIssueId));
    const [firstLinkAfterExit] = await db
      .select()
      .from(pipelineCaseIssueLinks)
      .where(eq(pipelineCaseIssueLinks.automationAttemptId, firstEntered.automationLedger!.id));
    expect(sharedAfterFirstExit?.status).toBe("todo");
    expect(firstLinkAfterExit).toMatchObject({ retiredReason: "stage_exited" });

    releaseSecondReservation();
    await secondEntry;

    const [secondLink] = await db
      .select()
      .from(pipelineCaseIssueLinks)
      .where(eq(pipelineCaseIssueLinks.id, reservedLink!.id));
    const [sharedAfterAttachment] = await db.select().from(issues).where(eq(issues.id, sharedIssueId));
    expect(secondLink).toMatchObject({ attachmentState: "attached", retiredAt: null, retiredReason: null });
    expect(sharedAfterAttachment?.status).toBe("todo");
  });

  // BLO-21605: `updateStageAutomationEnv` used to fire `logActivity` from
  // inside its `db.transaction` callback, so a consumer could receive
  // `activity.logged` before the routine-revision bump committed, and a
  // rolled-back transaction still emitted an event for a revision that never
  // existed.
  describe("updateStageAutomationEnv activity publication", () => {
    async function routineRevisionNumber(routineId: string) {
      return db
        .select({ latestRevisionNumber: routines.latestRevisionNumber })
        .from(routines)
        .where(eq(routines.id, routineId))
        .then((rows) => rows[0]?.latestRevisionNumber ?? null);
    }

    // Subscribes to `activity.logged` for the given action and, at the moment
    // each event fires, kicks off a `snapshot()` read on a connection outside
    // the transaction that logged it. Whether that read observes the
    // committed effect is what distinguishes "published after commit" from
    // "published from inside the transaction".
    function captureActivityEvents<T>(companyId: string, action: string, snapshot: () => Promise<T>) {
      const seen: { valueAtPublish: Promise<T> }[] = [];
      const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
        if (event.type !== "activity.logged") return;
        const payload = event.payload as Record<string, unknown>;
        if (payload.action !== action) return;
        seen.push({ valueAtPublish: snapshot() });
      });
      return { seen, stop: unsubscribe };
    }

    async function seedAutomatedStage() {
      const { company, pipeline, byKey } = await seedPipeline();
      const routineSeed = await seedRoutine(company.id, "Env publish seed");
      const stageId = byKey.get("in_progress")!.id;
      const savedStage = await svc.updateStage({
        companyId: company.id,
        pipelineId: pipeline.id,
        stageId,
        patch: {
          config: {
            automation: {
              assigneeAgentId: routineSeed.assigneeAgentId,
              instructionsBody: "Env publication probe.",
            },
          },
        },
        actor: userActor,
      });
      const routineId = (savedStage.config as { onEnter?: { routineId?: string } }).onEnter!.routineId!;
      return { company, pipeline, stageId, routineId };
    }

    it("emits no activity.logged event when the env update transaction fails to commit", async () => {
      const { company, pipeline, stageId, routineId } = await seedAutomatedStage();
      const revisionBefore = await routineRevisionNumber(routineId);

      // Runs the real transaction — routine revision bump, pipeline_stages
      // update, and the activity_log insert all succeed — then aborts it,
      // standing in for a commit-time failure.
      const rollbackDb = new Proxy(db, {
        get(target, property, receiver) {
          if (property === "transaction") {
            return (callback: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
              (target.transaction as unknown as (
                cb: (tx: unknown) => Promise<unknown>,
                ...args: unknown[]
              ) => Promise<unknown>)(async (tx) => {
                await callback(tx);
                throw new Error("simulated commit failure after insert");
              }, ...rest);
          }
          return Reflect.get(target, property, receiver);
        },
      }) as typeof db;
      const rollbackSvc = pipelineService(rollbackDb, { heartbeat: noopHeartbeat });

      const events = captureActivityEvents(
        company.id,
        "pipeline.stage_automation_env_updated",
        () => routineRevisionNumber(routineId),
      );
      try {
        await expect(rollbackSvc.updateStageAutomationEnv({
          companyId: company.id,
          pipelineId: pipeline.id,
          stageId,
          env: null,
          actor: userActor,
        })).rejects.toBeDefined();
      } finally {
        events.stop();
      }

      expect(
        events.seen,
        "a rolled-back env update must not publish a phantom activity event",
      ).toHaveLength(0);
      await expect(routineRevisionNumber(routineId)).resolves.toBe(revisionBefore);
    });

    it("publishes pipeline.stage_automation_env_updated only once the revision bump is visible", async () => {
      const { company, pipeline, stageId, routineId } = await seedAutomatedStage();

      const events = captureActivityEvents(
        company.id,
        "pipeline.stage_automation_env_updated",
        () => routineRevisionNumber(routineId),
      );
      let result: Awaited<ReturnType<typeof svc.updateStageAutomationEnv>>;
      try {
        result = await svc.updateStageAutomationEnv({
          companyId: company.id,
          pipelineId: pipeline.id,
          stageId,
          env: null,
          actor: userActor,
        });
      } finally {
        events.stop();
      }

      expect(events.seen).toHaveLength(1);
      const revisionAfter = await routineRevisionNumber(routineId);
      expect(result).toBeDefined();
      // Read taken from inside the event listener, on a connection outside
      // the updating transaction: the bumped revision is only visible there
      // after commit, so a pre-commit publication would observe the stale
      // (pre-update) revision number instead.
      await expect(
        events.seen[0]!.valueAtPublish,
        "the bumped revision must already be visible to other connections when the event fires",
      ).resolves.toBe(revisionAfter);
    });

    it("observes and logs a throwing live-event subscriber after the env update commits", async () => {
      const { company, pipeline, stageId } = await seedAutomatedStage();
      const warning = "failed to publish pipeline.stage_automation_env_updated activity event";
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
      const unsubscribe = subscribeCompanyLiveEvents(company.id, (event) => {
        if (
          event.type === "activity.logged" &&
          (event.payload as Record<string, unknown>).action === "pipeline.stage_automation_env_updated"
        ) {
          throw new Error("pipeline live subscriber exploded");
        }
      });
      let warningCalls: unknown[][] = [];

      try {
        await svc.updateStageAutomationEnv({
          companyId: company.id,
          pipelineId: pipeline.id,
          stageId,
          env: null,
          actor: userActor,
        });
        warningCalls = warnSpy.mock.calls.map((call) => [...call]);
      } finally {
        unsubscribe();
        warnSpy.mockRestore();
      }

      expect(
        warningCalls,
        "the post-commit publisher must be awaited so subscriber failures reach the existing logger",
      ).toEqual(expect.arrayContaining([
        [
          expect.objectContaining({
            err: expect.objectContaining({ message: "pipeline live subscriber exploded" }),
            companyId: company.id,
            stageId,
          }),
          warning,
        ],
      ]));
    });
  });
});
