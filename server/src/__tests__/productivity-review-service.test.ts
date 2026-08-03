import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { MAX_ISSUE_REQUEST_DEPTH } from "@paperclipai/shared";
import {
  DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS,
  DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
  DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS,
  ISSUE_MONITOR_WAKE_CLAIM_TTL_MS,
  PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS,
  PRODUCTIVITY_REVIEW_ORIGIN_KIND,
  PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX,
  productivityReviewService,
} from "../services/productivity-review.js";
import { logActivity } from "../services/activity-log.js";
import { RECOVERY_ORIGIN_KINDS } from "../services/recovery/origins.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres productivity review tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("productivity review service", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-productivity-review-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  async function linkApproval(
    companyId: string,
    issueId: string,
    status: string,
    opts?: { createdAt?: Date },
  ) {
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status,
      payload: { reason: "human gate" },
      ...(opts?.createdAt ? { createdAt: opts.createdAt } : {}),
    });
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId });
    return approvalId;
  }

  async function seedAssignedIssue(opts?: {
    status?: "todo" | "in_progress" | "done" | "cancelled";
    startedAt?: Date;
    monitorNextCheckAt?: Date | null;
    monitorScheduledBy?: "assignee" | "board" | null;
    monitorLastTriggeredAt?: Date | null;
    monitorWakeRequestedAt?: Date | null;
    parentId?: string | null;
    originKind?: string;
    executionPolicy?: Record<string, unknown> | null;
  }) {
    const companyId = randomUUID();
    const ownerUserId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `PR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const createdAt = new Date("2026-04-28T10:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Productivity Review Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      status: "active",
      membershipRole: "owner",
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
      id: issueId,
      companyId,
      title: "Implement data import",
      status: opts?.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      parentId: opts?.parentId ?? null,
      originKind: opts?.originKind ?? "manual",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: opts?.startedAt ?? createdAt,
      monitorNextCheckAt: opts?.monitorNextCheckAt ?? null,
      monitorScheduledBy: opts?.monitorScheduledBy ?? null,
      monitorLastTriggeredAt: opts?.monitorLastTriggeredAt ?? null,
      monitorWakeRequestedAt: opts?.monitorWakeRequestedAt ?? null,
      executionPolicy: opts?.executionPolicy ?? null,
      createdAt,
      updatedAt: createdAt,
    });

    return { companyId, ownerUserId, managerId, coderId, issueId, issuePrefix, createdAt };
  }

  async function insertRuns(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    count: number;
    now: Date;
    withRunComments?: boolean;
    contextSource?: string;
  }) {
    const runs: Array<typeof heartbeatRuns.$inferInsert> = [];
    for (let index = 0; index < input.count; index += 1) {
      const runId = randomUUID();
      const createdAt = new Date(input.now.getTime() - index * 60_000);
      runs.push({
        id: runId,
        companyId: input.companyId,
        agentId: input.agentId,
        status: "succeeded",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 30_000),
        contextSnapshot: input.contextSource
          ? { issueId: input.issueId, taskId: input.issueId, source: input.contextSource }
          : { issueId: input.issueId, taskId: input.issueId },
        livenessState: "advanced",
        nextAction: "Continue processing the next batch.",
        createdAt,
        updatedAt: createdAt,
      });
    }
    await db.insert(heartbeatRuns).values(runs);

    if (input.withRunComments) {
      await db.insert(issueComments).values(
        runs.map((run, index) => ({
          companyId: input.companyId,
          issueId: input.issueId,
          authorAgentId: input.agentId,
          createdByRunId: run.id,
          body: `Progress update ${index}`,
          createdAt: run.createdAt as Date,
          updatedAt: run.createdAt as Date,
        })),
      );
    }

    return runs;
  }

  async function listProductivityReviews(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND)))
      .orderBy(issues.createdAt);
  }

  async function listRefreshComments(reviewIssueId: string) {
    return db
      .select()
      .from(issueComments)
      .where(and(
        eq(issueComments.issueId, reviewIssueId),
        sql`${issueComments.body} like ${`${PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX}%`}`,
      ))
      .orderBy(issueComments.createdAt);
  }

  async function listProductivityReviewEscalations(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, RECOVERY_ORIGIN_KINDS.productivityReviewEscalation)))
      .orderBy(issues.createdAt);
  }

  async function insertResolvedProductivityReviews(input: {
    companyId: string;
    sourceIssueId: string;
    issuePrefix: string;
    count: number;
    now: Date;
    ageMs?: number;
    status?: "done" | "cancelled";
    hiddenAt?: Date | null;
  }) {
    await db.insert(issues).values(
      Array.from({ length: input.count }, (_, index) => {
        const createdAt = new Date(input.now.getTime() - (input.ageMs ?? 7 * 60 * 60 * 1000) - index * 60_000);
        return {
          id: randomUUID(),
          companyId: input.companyId,
          title: `Resolved productivity review ${index}`,
          status: input.status ?? "done",
          priority: "high",
          originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
          originId: input.sourceIssueId,
          originFingerprint: `productivity-review:${input.sourceIssueId}`,
          parentId: input.sourceIssueId,
          issueNumber: index + 10,
          identifier: `${input.issuePrefix}-${randomUUID().slice(0, 8)}`,
          hiddenAt: input.hiddenAt ?? null,
          createdAt,
          updatedAt: createdAt,
        };
      }),
    );
  }

  it("creates exactly one manager-assigned review for a no-comment run streak and rate-limits immediate refresh", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const service = productivityReviewService(db);
    const first = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const second = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(first.created).toBe(1);
    expect(second.updated).toBe(0);
    expect(second.existing).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.parentId).toBe(seeded.issueId);
    expect(reviews[0]?.assigneeAgentId).toBe(seeded.managerId);
    expect(reviews[0]?.assigneeAdapterOverrides).toEqual({ modelProfile: "cheap" });
    expect(reviews[0]?.originId).toBe(seeded.issueId);
    expect(reviews[0]?.originFingerprint).toBe(`productivity-review:${seeded.issueId}`);
    expect(reviews[0]?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(reviews[0]?.description).toContain("No-comment completed-run streak: 10");

    expect(await listRefreshComments(reviews[0]!.id)).toHaveLength(0);
  });

  // BLO-19094: an open review grants its assignee issue:comment/issue:mutate on
  // the SOURCE issue, and an issue with no agent assignee is mutable by any
  // company agent (allow_company_agent). An unassigned review would therefore
  // let any agent self-assign the dangling row and inherit mutation rights on a
  // source issue it has no relationship to. It was already a dead row — the
  // assignment wake is gated on the resolved owner — so it is never created.
  it("does not open an unassigned review when no invokable review owner can be resolved", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    // The only candidate (the coder's manager, who is also the sole cto/ceo
    // role holder) is not invokable, so resolveReviewOwnerAgentId returns null.
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, seeded.managerId));
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("refreshes open productivity reviews only once per interval and caps refresh comments", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);

    const firstRefreshAt = new Date(now.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS);
    const firstRefresh = await service.reconcileProductivityReviews({
      now: firstRefreshAt,
      companyId: seeded.companyId,
    });
    const tooSoonRefresh = await service.reconcileProductivityReviews({
      now: new Date(firstRefreshAt.getTime() + 30 * 60 * 1000),
      companyId: seeded.companyId,
    });
    await service.reconcileProductivityReviews({
      now: new Date(firstRefreshAt.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS),
      companyId: seeded.companyId,
    });
    await service.reconcileProductivityReviews({
      now: new Date(firstRefreshAt.getTime() + 2 * DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS),
      companyId: seeded.companyId,
    });
    const cappedRefresh = await service.reconcileProductivityReviews({
      now: new Date(firstRefreshAt.getTime() + 3 * DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS),
      companyId: seeded.companyId,
    });

    expect(firstRefresh.updated).toBe(1);
    expect(tooSoonRefresh.updated).toBe(0);
    expect(tooSoonRefresh.existing).toBe(1);
    expect(cappedRefresh.updated).toBe(0);
    expect(cappedRefresh.existing).toBe(1);
    expect(await listRefreshComments(review!.id)).toHaveLength(DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS);
  });

  it("allows only one productivity review per source issue in 24 hours", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    const createdAt = new Date(now.getTime() - 8 * 60 * 60 * 1000);
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      title: "Completed productivity review",
      status: "done",
      priority: "high",
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      parentId: seeded.issueId,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt,
      updatedAt: createdAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.creationCapped).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);
  });

  it("suppresses creation after three consecutive completed reviews with no source action", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await db.insert(issues).values(
      [96, 72, 48].map((hoursAgo, index) => {
        const createdAt = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
        return {
          id: randomUUID(),
          companyId: seeded.companyId,
          title: `No-action productivity review ${index + 1}`,
          status: "done",
          priority: "high",
          originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
          originId: seeded.issueId,
          originFingerprint: `productivity-review:${seeded.issueId}`,
          parentId: seeded.issueId,
          issueNumber: index + 2,
          identifier: `${seeded.issuePrefix}-${index + 2}`,
          createdAt,
          updatedAt: new Date(createdAt.getTime() + 60 * 60 * 1000),
        };
      }),
    );

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.noActionSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(3);
  });

  it("resets no-action suppression for source action after a zero-duration review", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    const reviewWindows = [96, 72, 48].map((hoursAgo, index) => {
      const createdAt = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
      return {
        id: randomUUID(),
        companyId: seeded.companyId,
        title: `Productivity review ${index + 1}`,
        status: "done" as const,
        priority: "high" as const,
        originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
        originId: seeded.issueId,
        originFingerprint: `productivity-review:${seeded.issueId}`,
        parentId: seeded.issueId,
        issueNumber: index + 2,
        identifier: `${seeded.issuePrefix}-${index + 2}`,
        createdAt,
        updatedAt: new Date(createdAt.getTime() + 60 * 60 * 1000),
      };
    });
    const actedReview = reviewWindows[1]!;
    actedReview.updatedAt = actedReview.createdAt;
    await db.insert(issues).values(reviewWindows);
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.coderId,
      agentId: seeded.coderId,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issueId,
      createdAt: new Date(actedReview.createdAt.getTime() + 2 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.noActionSuppressed).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(4);
  });

  it("uses review creation order for no-action streak windows", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    const reviewWindows = [
      { hoursAgo: 96, updatedAt: new Date(now.getTime() - 95 * 60 * 60 * 1000) },
      { hoursAgo: 72, updatedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000) },
      { hoursAgo: 48, updatedAt: new Date(now.getTime() - 47 * 60 * 60 * 1000) },
    ].map((window, index) => {
      const createdAt = new Date(now.getTime() - window.hoursAgo * 60 * 60 * 1000);
      return {
        id: randomUUID(),
        companyId: seeded.companyId,
        title: `Productivity review ordered window ${index + 1}`,
        status: "done" as const,
        priority: "high" as const,
        originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
        originId: seeded.issueId,
        originFingerprint: `productivity-review:${seeded.issueId}`,
        parentId: seeded.issueId,
        issueNumber: index + 2,
        identifier: `${seeded.issuePrefix}-${index + 2}`,
        createdAt,
        updatedAt: window.updatedAt,
      };
    });
    const middleReviewCreatedAt = reviewWindows[1]!.createdAt;
    await db.insert(issues).values(reviewWindows);
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.coderId,
      agentId: seeded.coderId,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issueId,
      createdAt: new Date(middleReviewCreatedAt.getTime() + 60_000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { maxConsecutiveNoActionReviews: 1 },
    });

    expect(result.created).toBe(0);
    expect(result.noActionSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(3);
  });

  it("does not count cancelled productivity reviews toward the creation cap", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await db.insert(issues).values(
      [8, 9, 10].map((hoursAgo, index) => {
        const createdAt = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
        return {
          id: randomUUID(),
          companyId: seeded.companyId,
          title: `Cancelled productivity review ${index + 1}`,
          status: "cancelled",
          priority: "high",
          originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
          originId: seeded.issueId,
          originFingerprint: `productivity-review:${seeded.issueId}`,
          parentId: seeded.issueId,
          issueNumber: index + 2,
          identifier: `${seeded.issuePrefix}-${index + 2}`,
          createdAt,
          updatedAt: createdAt,
        };
      }),
    );

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.creationCapped).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(4);
  });

  it("suppresses long-active productivity reviews when a linked board approval is pending", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    const approvalId = await linkApproval(seeded.companyId, seeded.issueId, "pending", {
      createdAt: new Date(now.getTime() - 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.approvalGatedSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);

    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_suppressed"));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.entityId).toBe(seeded.issueId);
    expect(activities[0]?.details).toMatchObject({
      trigger: "long_active_duration",
      suppressedBy: "approval_pending",
      approvalId,
      approvalStatus: "pending",
      approvalType: "request_board_approval",
    });
  });

  it("creates long-active productivity reviews once the linked approval is decided", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await linkApproval(seeded.companyId, seeded.issueId, "approved");

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.approvalGatedSuppressed).toBe(0);
  });

  it("does not suppress long-active reviews for a revision_requested approval (ball is back with the agent)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await linkApproval(seeded.companyId, seeded.issueId, "revision_requested", {
      createdAt: new Date(now.getTime() - 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.approvalGatedSuppressed).toBe(0);
  });

  it("does not suppress long-active reviews for a rejected approval", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await linkApproval(seeded.companyId, seeded.issueId, "rejected", {
      createdAt: new Date(now.getTime() - 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.approvalGatedSuppressed).toBe(0);
  });

  // An approval nobody has decided for longer than the gate window is itself the stuck thing.
  // Without this bound a forgotten `pending` row would disable the long-active detector on that
  // issue permanently — inverting the case the detector exists for.
  it("stops suppressing once the pending approval ages past the gate window", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await linkApproval(seeded.companyId, seeded.issueId, "pending", {
      createdAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.approvalGatedSuppressed).toBe(0);
  });

  it("does not reset the issue gate window with a newer pending approval", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await linkApproval(seeded.companyId, seeded.issueId, "pending", {
      createdAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
    });
    await linkApproval(seeded.companyId, seeded.issueId, "pending", {
      createdAt: new Date(now.getTime() - 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.approvalGatedSuppressed).toBe(0);
  });

  // `longActiveMs` and `approvalGateMaxAgeMs` are read independently from overrides, so a
  // config pair can put the gate's expiry at or below the trigger it suppresses — the gate
  // would then always be stale by the time a long-active review is considered, silently
  // disabling the feature. `buildThresholds` clamps the gate up to `longActiveMs`.
  it("clamps an approval gate max age below the long-active threshold so the gate still engages", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    // Two hours old: stale against the requested 1h gate, fresh against the 6h clamp.
    await linkApproval(seeded.companyId, seeded.issueId, "pending", {
      createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: {
        longActiveMs: 6 * 60 * 60 * 1000,
        approvalGateMaxAgeMs: 60 * 60 * 1000,
      },
    });

    expect(result.approvalGatedSuppressed).toBe(1);
    expect(result.created).toBe(0);
  });

  it("does not suppress no-comment productivity reviews when an approval is pending", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({ status: "in_progress" });
    await linkApproval(seeded.companyId, seeded.issueId, "pending");
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.approvalGatedSuppressed).toBe(0);
    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `no_comment_streak`");
  });

  // The suppression is forward-only. A pending approval stops the *next* long-active review from
  // being minted, but must never retire one that already fired: the reviewed agent can create the
  // approval itself, so honouring it on the close path would let a flagged agent erase its own
  // oversight artifact. Only a scheduled monitor closes an open review.
  it("does not close an open long-active review when the source has a pending approval", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await linkApproval(seeded.companyId, seeded.issueId, "pending", {
      createdAt: new Date(now.getTime() - 60 * 60 * 1000),
    });
    const reviewId = randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: seeded.companyId,
      title: "Review productivity for source",
      status: "todo",
      priority: "medium",
      parentId: seeded.issueId,
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt: now,
      updatedAt: now,
    });
    await logActivity(db, {
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: reviewId,
      details: {
        trigger: "long_active_duration",
        sourceIssueId: seeded.issueId,
      },
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.closedSuppressedMonitorReviews).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.status).toBe("todo");

    const closures = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_suppressed_open_review_closed"));
    expect(closures).toHaveLength(0);
  });

  it("creates a long-active review without enabling a continuation hold", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    const service = productivityReviewService(db);

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const hold = await service.isProductivityReviewContinuationHoldActive({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      agentId: seeded.coderId,
      now,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
    expect(review?.priority).toBe("medium");
    expect(hold.held).toBe(false);
  });

  it("suppresses long-active productivity reviews for deliberate future monitor waits", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.monitorScheduledSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);

    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_suppressed"));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.entityId).toBe(seeded.issueId);
    expect(activities[0]?.details).toMatchObject({
      trigger: "long_active_duration",
      suppressedBy: "monitor_scheduled",
      monitorNextCheckAt: monitorNextCheckAt.toISOString(),
      monitorScheduledBy: "assignee",
    });
  });

  it("creates long-active productivity reviews when the scheduled monitor has expired", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() - 10 * 60_000),
      monitorScheduledBy: "assignee",
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
  });

  // BLO-21003: the monitor came due seconds ago, but `monitorNextCheckAt` lapsing
  // is not proof its wake was serviced — dispatch (tick pickup, K8s Job creation,
  // pod scheduling) is asynchronous and a reconcile pass can land inside that gap
  // (observed ~29s on BLO-19772). This must still suppress like a strictly-future
  // monitor, not read as an unattended stall.
  it("suppresses long-active productivity reviews for a monitor that lapsed seconds ago with its wake unserviced", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 5_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.monitorScheduledSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);

    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_suppressed"));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.details).toMatchObject({
      suppressedBy: "monitor_scheduled",
      monitorNextCheckAt: monitorNextCheckAt.toISOString(),
      monitorScheduledBy: "assignee",
      monitorWakeRequestedAt: null,
    });
  });

  it("suppresses long-active reviews when scheduler-derived monitor grace is longer than one minute", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 90_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorSchedulerIntervalMs: 2 * 60_000 },
    });

    expect(result.created).toBe(0);
    expect(result.monitorScheduledSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("suppresses a due monitor still waiting behind the scheduler dispatch batch", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 6 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });
    await db.insert(issues).values(
      Array.from({ length: 50 }, (_, index) => ({
        id: randomUUID(),
        companyId: seeded.companyId,
        title: `Earlier due monitor ${index + 1}`,
        status: "in_review" as const,
        priority: "medium" as const,
        assigneeAgentId: seeded.coderId,
        monitorNextCheckAt: new Date(now.getTime() - 7 * 60_000),
        monitorScheduledBy: "assignee" as const,
        issueNumber: index + 20,
        identifier: `${seeded.issuePrefix}-${index + 20}`,
        createdAt: seeded.createdAt,
        updatedAt: seeded.createdAt,
      })),
    );

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: {
        monitorLapseServiceGraceMs: 60_000,
        monitorSchedulerIntervalMs: 60_000,
        monitorDispatchBatchSize: 50,
      },
    });

    expect(result.created).toBe(0);
    expect(result.monitorScheduledSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("does not extend first-batch grace for later monitors with the same due timestamp", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 6 * 60_000 - 1_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });
    await db.insert(issues).values(
      Array.from({ length: 100 }, (_, index) => ({
        id: randomUUID(),
        companyId: seeded.companyId,
        title: `Later equal-time monitor ${index + 1}`,
        status: "in_review" as const,
        priority: "medium" as const,
        assigneeAgentId: seeded.coderId,
        monitorNextCheckAt,
        monitorScheduledBy: "assignee" as const,
        issueNumber: index + 20,
        identifier: `${seeded.issuePrefix}-${index + 20}`,
        createdAt: seeded.createdAt,
        updatedAt: new Date(seeded.createdAt.getTime() + (index + 1) * 1_000),
      })),
    );

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: {
        monitorLapseServiceGraceMs: 6 * 60_000,
        monitorSchedulerIntervalMs: 60_000,
        monitorDispatchBatchSize: 50,
      },
    });

    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
  });

  it("suppresses a monitor still queued after earlier scheduler batches have drained", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 9 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });
    await db.insert(issues).values(
      Array.from({ length: 49 }, (_, index) => ({
        id: randomUUID(),
        companyId: seeded.companyId,
        title: `Remaining earlier monitor ${index + 1}`,
        status: "in_review" as const,
        priority: "medium" as const,
        assigneeAgentId: seeded.coderId,
        monitorNextCheckAt,
        monitorScheduledBy: "assignee" as const,
        issueNumber: index + 20,
        identifier: `${seeded.issuePrefix}-${index + 20}`,
        createdAt: seeded.createdAt,
        updatedAt: new Date(seeded.createdAt.getTime() - (index + 1) * 1_000),
      })),
    );

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: {
        monitorLapseServiceGraceMs: 6 * 60_000,
        monitorSchedulerIntervalMs: 60_000,
        monitorDispatchBatchSize: 50,
      },
    });

    expect(result.created).toBe(0);
    expect(result.monitorScheduledSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("suppresses a lapsed monitor claimed by the scheduler after candidate selection", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 10 * 60_000);
    const monitorWakeRequestedAt = new Date(now.getTime() - 4 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });

    const result = await productivityReviewService(db, {
      async beforeCollectEvidence(sourceIssue) {
        if (sourceIssue.id !== seeded.issueId) return;
        await db
          .update(issues)
          .set({ monitorWakeRequestedAt, updatedAt: monitorWakeRequestedAt })
          .where(eq(issues.id, seeded.issueId));
      },
    }).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000 },
    });

    expect(result.created).toBe(0);
    expect(result.monitorScheduledSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);

    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_suppressed"));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.details).toMatchObject({
      suppressedBy: "monitor_scheduled",
      monitorNextCheckAt: monitorNextCheckAt.toISOString(),
      monitorWakeRequestedAt: monitorWakeRequestedAt.toISOString(),
    });
  });

  it("suppresses a lapsed monitor claimed after the current-state read but before backlog counting", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 10 * 60_000);
    const monitorWakeRequestedAt = new Date(now.getTime() - 4 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });

    const result = await productivityReviewService(db, {
      async beforeMonitorBacklogGrace(sourceIssue) {
        if (sourceIssue.id !== seeded.issueId) return;
        await db
          .update(issues)
          .set({ monitorWakeRequestedAt, updatedAt: monitorWakeRequestedAt })
          .where(eq(issues.id, seeded.issueId));
      },
    }).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000 },
    });

    expect(result.created).toBe(0);
    expect(result.monitorScheduledSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);

    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_suppressed"));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.details).toMatchObject({
      suppressedBy: "monitor_scheduled",
      monitorNextCheckAt: monitorNextCheckAt.toISOString(),
      monitorWakeRequestedAt: monitorWakeRequestedAt.toISOString(),
    });
  });

  it("suppresses a source queued behind a fresh-claimed predecessor monitor", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 10 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      title: "Fresh claimed predecessor monitor",
      status: "in_review" as const,
      priority: "medium" as const,
      assigneeAgentId: seeded.coderId,
      monitorNextCheckAt,
      monitorScheduledBy: "assignee" as const,
      monitorWakeRequestedAt: new Date(now.getTime() - 4 * 60_000),
      issueNumber: 20,
      identifier: `${seeded.issuePrefix}-20`,
      createdAt: seeded.createdAt,
      updatedAt: new Date(seeded.createdAt.getTime() - 1_000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: {
        monitorLapseServiceGraceMs: 60_000,
        monitorSchedulerIntervalMs: 60_000,
        monitorDispatchBatchSize: 50,
      },
    });

    expect(result.created).toBe(0);
    expect(result.monitorScheduledSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("suppresses long-active reviews for a lapsed monitor with a fresh dispatch claim", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 10 * 60_000);
    const monitorWakeRequestedAt = new Date(now.getTime() - 4 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
      monitorWakeRequestedAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000 },
    });

    expect(result.created).toBe(0);
    expect(result.monitorScheduledSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);

    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_suppressed"));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.details).toMatchObject({
      suppressedBy: "monitor_scheduled",
      monitorNextCheckAt: monitorNextCheckAt.toISOString(),
      monitorWakeRequestedAt: monitorWakeRequestedAt.toISOString(),
    });
  });

  it("suppresses a lapsed monitor claimed exactly at the scheduler claim TTL boundary", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 10 * 60_000);
    const monitorWakeRequestedAt = new Date(now.getTime() - ISSUE_MONITOR_WAKE_CLAIM_TTL_MS);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
      monitorWakeRequestedAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000 },
    });

    expect(result.created).toBe(0);
    expect(result.monitorScheduledSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);

    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_suppressed"));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.details).toMatchObject({
      suppressedBy: "monitor_scheduled",
      monitorNextCheckAt: monitorNextCheckAt.toISOString(),
      monitorWakeRequestedAt: monitorWakeRequestedAt.toISOString(),
    });
  });

  // Negative control for BLO-21003: a monitor that lapsed well past the
  // lapse-to-service grace window, with no pending wake, is genuinely
  // unsupervised and must still fire exactly as it does today. Without this
  // case, a fix that simply disabled the trigger (e.g. always suppressing)
  // would pass the positive test above too.
  it("still creates a long-active review when the monitor lapsed well past the service grace window", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() - 10 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
  });

  // BLO-21003 AC3: even outside the suppression window (monitor already
  // triggered, `monitorNextCheckAt` cleared), a sub-minute nonzero unattended
  // residue must not floor to `0m` — that reads as "measured and zero" rather
  // than "sub-minute and real". Replays the BLO-19772 shape (14h10m elapsed,
  // wake serviced ~29s after the monitor came due) but reports the residue
  // directly as seconds instead of flooring it away.
  it("reports a sub-minute unattended residue in seconds instead of flooring it to 0m", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const startedAt = new Date(now.getTime() - (14 * 60 + 10) * 60 * 1000);
    const monitorLastTriggeredAt = new Date(now.getTime() - 45_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt,
      monitorNextCheckAt: null,
      monitorScheduledBy: "assignee",
      monitorLastTriggeredAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain(
      `- Elapsed accounting: 14h 9m monitor-gated, 45s unattended (monitor lapsed at ${monitorLastTriggeredAt.toISOString()}, never re-armed)`,
    );
    expect(review?.description).not.toContain("0m unattended");
  });

  it("reports the whole episode as unattended when no monitor was ever armed", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain(
      "- Elapsed accounting: 0m monitor-gated, 7h 0m unattended (no monitor armed during this episode)",
    );
  });

  // Replay of the BLO-19067 episode that prompted BLO-19774, using its real
  // timestamps from the issues row. The ticket asserted the monitor was still
  // armed with a future nextCheckAt; it was not — monitor_next_check_at was NULL
  // and monitor_last_triggered_at was 2026-07-30T22:36:42.405Z, so only the
  // first 1h23m of the 15h53m episode was monitor-gated. The review therefore
  // still fires (correctly: 14h30m genuinely unattended), and the evidence block
  // must make that split legible to the adjudicating manager.
  it("splits monitor-gated from unattended elapsed time when the monitor lapsed (BLO-19067 replay)", async () => {
    const startedAt = new Date("2026-07-30T21:13:34.758Z");
    const monitorLastTriggeredAt = new Date("2026-07-30T22:36:42.405Z");
    const now = new Date("2026-07-31T13:07:26.406Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt,
      monitorNextCheckAt: null,
      monitorScheduledBy: "assignee",
      monitorLastTriggeredAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Current active elapsed time: 15h 53m");
    expect(review?.description).toContain(
      `- Elapsed accounting: 1h 23m monitor-gated, 14h 30m unattended (monitor lapsed at ${monitorLastTriggeredAt.toISOString()}, never re-armed)`,
    );
  });

  // The still-armed branch is the one a manager is most likely to act on: it
  // attributes the entire episode to gating because no column records when the
  // monitor was armed. `monitorScheduledBy: null` reaches it without tripping
  // the deliberate-monitor suppression, so the qualifier itself is pinned —
  // an unqualified "15h monitor-gated, 0m unattended" would tell the manager a
  // real stall was fully accounted for.
  it("marks monitor-gated time as an upper bound while the monitor is still armed", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const armedUntil = new Date(now.getTime() + 30 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 15 * 60 * 60 * 1000),
      monitorNextCheckAt: armedUntil,
      monitorScheduledBy: null,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain(
      `- Elapsed accounting: ≤15h 0m monitor-gated, ≥0m unattended (monitor armed until ${armedUntil.toISOString()}; arm time is not recorded, so monitor-gated time is an upper bound)`,
    );
  });

  // A monitor that lapsed before this episode began covers none of it. Without
  // the clamp the subtraction goes negative, yielding an `unattendedMs` larger
  // than the episode itself; without the separate branch the prose claims an
  // in-episode lapse and prints a timestamp from before `startedAt`.
  it("attributes nothing to gating when the last monitor lapsed before the episode began", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const priorLapseAt = new Date(now.getTime() - 9 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: priorLapseAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain(
      `- Elapsed accounting: 0m monitor-gated, 7h 0m unattended (no monitor armed during this episode; previous monitor lapsed at ${priorLapseAt.toISOString()}, before it began)`,
    );
  });

  it("does not suppress no-comment productivity reviews for future monitor waits", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `no_comment_streak`");
  });

  it("closes open long-active productivity reviews when the source has a deliberate future monitor", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      monitorScheduledBy: "board",
    });
    const reviewId = randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: seeded.companyId,
      title: "Review productivity for source",
      status: "todo",
      priority: "medium",
      parentId: seeded.issueId,
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt: now,
      updatedAt: now,
    });
    await logActivity(db, {
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: reviewId,
      details: {
        trigger: "long_active_duration",
        sourceIssueId: seeded.issueId,
      },
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.closedSuppressedMonitorReviews).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.status).toBe("done");
  });

  it("does not close an open long-active review for a recently lapsed monitor wake", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() - 5_000),
      monitorScheduledBy: "board",
      monitorWakeRequestedAt: new Date(now.getTime() - 1_000),
    });
    const reviewId = randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: seeded.companyId,
      title: "Review productivity for source",
      status: "todo",
      priority: "medium",
      parentId: seeded.issueId,
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt: now,
      updatedAt: now,
    });
    await logActivity(db, {
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: reviewId,
      details: {
        trigger: "long_active_duration",
        sourceIssueId: seeded.issueId,
      },
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.closedSuppressedMonitorReviews).toBe(0);
    expect(result.monitorScheduledSuppressed).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.status).toBe("todo");

    const closures = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_suppressed_open_review_closed"));
    expect(closures).toHaveLength(0);
  });

  it("does not close open no-comment productivity reviews when the source has a deliberate future monitor", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      monitorScheduledBy: "board",
    });
    const reviewId = randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: seeded.companyId,
      title: "Review productivity for source",
      status: "todo",
      priority: "high",
      parentId: seeded.issueId,
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt: now,
      updatedAt: now,
    });
    await logActivity(db, {
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: reviewId,
      details: {
        trigger: "no_comment_streak",
        sourceIssueId: seeded.issueId,
      },
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.closedSuppressedMonitorReviews).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.status).toBe("todo");
  });

  it("closes an open long-active productivity review once its source issue is done", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "done",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    const reviewId = randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: seeded.companyId,
      title: "Review productivity for source",
      status: "todo",
      priority: "medium",
      parentId: seeded.issueId,
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt: now,
      updatedAt: now,
    });
    await logActivity(db, {
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: reviewId,
      details: {
        trigger: "long_active_duration",
        sourceIssueId: seeded.issueId,
      },
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.closedTerminalSourceReviews).toBe(1);
    expect(result.closedSuppressedMonitorReviews).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.status).toBe("done");
    expect(review?.completedAt).toEqual(now);

    const closeEntries = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_suppressed_open_review_closed"));
    expect(closeEntries).toHaveLength(1);
    expect(closeEntries[0]?.entityId).toBe(reviewId);
    expect(closeEntries[0]?.details).toMatchObject({
      suppressedBy: "terminal_source",
      sourceStatus: "done",
      sourceIssueId: seeded.issueId,
    });
  });

  it("does not close a long-active productivity review when the source was cancelled", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "cancelled",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    const reviewId = randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: seeded.companyId,
      title: "Review productivity for source",
      status: "todo",
      priority: "medium",
      parentId: seeded.issueId,
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt: now,
      updatedAt: now,
    });
    await logActivity(db, {
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: reviewId,
      details: {
        trigger: "long_active_duration",
        sourceIssueId: seeded.issueId,
      },
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.closedTerminalSourceReviews).toBe(0);
    expect(result.closedSuppressedMonitorReviews).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.status).toBe("todo");
  });

  it("does not close a done-source review whose trigger was not long_active_duration", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({ status: "done" });
    const reviewId = randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: seeded.companyId,
      title: "Review productivity for source",
      status: "in_progress",
      priority: "high",
      parentId: seeded.issueId,
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt: now,
      updatedAt: now,
    });
    await logActivity(db, {
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: reviewId,
      details: {
        trigger: "no_comment_streak",
        sourceIssueId: seeded.issueId,
      },
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.closedTerminalSourceReviews).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.status).toBe("in_progress");
  });

  it("does not close a done-source review when creation trigger provenance is missing", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({ status: "done" });
    const reviewId = randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: seeded.companyId,
      title: "Review productivity for source",
      status: "todo",
      priority: "medium",
      parentId: seeded.issueId,
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt: now,
      updatedAt: now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.closedTerminalSourceReviews).toBe(0);
    expect(result.closedSuppressedMonitorReviews).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.status).toBe("todo");
  });

  it("logs and counts a terminal-source close only once when reconcilers race", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "done",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    const reviewId = randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: seeded.companyId,
      title: "Review productivity for source",
      status: "todo",
      priority: "medium",
      parentId: seeded.issueId,
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt: now,
      updatedAt: now,
    });
    await logActivity(db, {
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: reviewId,
      details: {
        trigger: "long_active_duration",
        sourceIssueId: seeded.issueId,
      },
    });

    const [first, second] = await Promise.all([
      productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      }),
      productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      }),
    ]);

    expect(first.closedTerminalSourceReviews + second.closedTerminalSourceReviews).toBe(1);
    const closeEntries = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_suppressed_open_review_closed"));
    expect(closeEntries).toHaveLength(1);
  });

  it("leaves an open productivity review alone while its source issue is still active", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    const reviewId = randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: seeded.companyId,
      title: "Review productivity for source",
      status: "todo",
      priority: "medium",
      parentId: seeded.issueId,
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt: now,
      updatedAt: now,
    });
    await logActivity(db, {
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: reviewId,
      details: {
        trigger: "long_active_duration",
        sourceIssueId: seeded.issueId,
      },
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.closedTerminalSourceReviews).toBe(0);
    expect(result.closedSuppressedMonitorReviews).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.status).toBe("todo");
  });

  it("creates a high-churn review even when every sampled run has a progress comment", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      monitorNextCheckAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
      withRunComments: true,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `high_churn`");
    expect(review?.description).toContain("Runs in rolling windows: 10/1h");
  });

  it("ignores non-assignee comments when evaluating high-churn productivity reviews", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 9,
      now,
    });
    const managerRuns = await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.managerId,
      issueId: seeded.issueId,
      count: 10,
      now,
    });
    await db.insert(issueComments).values(
      managerRuns.map((run, index) => ({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        authorAgentId: seeded.managerId,
        createdByRunId: run.id,
        body: `Manager note ${index}`,
        createdAt: run.createdAt as Date,
        updatedAt: run.createdAt as Date,
      })),
    );

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("does not create a repeat review from history alone when no current trigger exists", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({ status: "todo" });
    await db.insert(issues).values(
      [8, 9, 10].map((hoursAgo, index) => {
        const createdAt = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
        return {
          id: randomUUID(),
          companyId: seeded.companyId,
          title: `Completed productivity review ${index + 1}`,
          status: "done",
          priority: "high",
          originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
          originId: seeded.issueId,
          originFingerprint: `productivity-review:${seeded.issueId}`,
          parentId: seeded.issueId,
          issueNumber: index + 2,
          identifier: `${seeded.issuePrefix}-${index + 2}`,
          createdAt,
          updatedAt: createdAt,
        };
      }),
    );

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(3);
  });

  it("isolates one candidate's review failure and continues reconciling other candidates", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const bad = await seedAssignedIssue();
    const good = await seedAssignedIssue();
    for (const seeded of [bad, good]) {
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });
    }

    const result = await productivityReviewService(db, {
      beforeCreateOrUpdateReview(evidence) {
        if (evidence.sourceIssue.id === bad.issueId) throw new Error("synthetic review failure");
      },
    }).reconcileProductivityReviews({ now });

    expect(result.failed).toBe(1);
    expect(result.failedIssueIds).toEqual([bad.issueId]);
    expect(result.created).toBe(1);
    expect(await listProductivityReviews(bad.companyId)).toHaveLength(0);
    expect(await listProductivityReviews(good.companyId)).toHaveLength(1);
  });

  it("deduplicates concurrent productivity review creation for the same source", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const [first, second] = await Promise.all([
      productivityReviewService(db).reconcileProductivityReviews({ now, companyId: seeded.companyId }),
      productivityReviewService(db).reconcileProductivityReviews({ now, companyId: seeded.companyId }),
    ]);

    expect(first.created + second.created).toBe(1);
    expect(first.failed + second.failed).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);
  });

  for (const terminalStatus of ["done", "cancelled"] as const) {
    it(`suppresses a no_comment_streak review as an audit-only decision when the source is ${terminalStatus} (BLO-6243)`, async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });

      const result = await productivityReviewService(db, {
        async beforeCreateOrUpdateReview(evidence) {
          if (evidence.sourceIssue.id === seeded.issueId) {
            await db
              .update(issues)
              .set({ status: terminalStatus })
              .where(eq(issues.id, seeded.issueId));
          }
        },
      }).reconcileProductivityReviews({ now, companyId: seeded.companyId });

      // No review issue is emitted and no generic skip is counted — the terminal source is a
      // distinct, attributable suppression.
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.suppressedTerminalSource).toBe(1);
      expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);

      const [source] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
      expect(source?.status).toBe(terminalStatus);

      // The suppression is recorded as an audit-only decision on the source issue.
      const suppressions = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "issue.productivity_review_suppressed"));
      expect(suppressions).toHaveLength(1);
      expect(suppressions[0]?.entityId).toBe(seeded.issueId);
      expect(suppressions[0]?.details).toMatchObject({
        decision: "suppress_terminal_source",
        sourceStatus: terminalStatus,
        trigger: "no_comment_streak",
      });
    });
  }

  it("keeps emitting a no_comment_streak review while the source stays in_progress (BLO-6243 control)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.suppressedTerminalSource).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);
    const suppressions = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_suppressed"));
    expect(suppressions).toHaveLength(0);
  });

  it("skips productivity-review descendants so reviews cannot recursively spawn reviews", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const reviewId = randomUUID();
    const childId = randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: seeded.companyId,
      title: "Existing productivity review",
      status: "todo",
      priority: "high",
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      parentId: seeded.issueId,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
    });
    await db.insert(issues).values({
      id: childId,
      companyId: seeded.companyId,
      title: "Review follow-up child",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: seeded.coderId,
      parentId: reviewId,
      issueNumber: 3,
      identifier: `${seeded.issuePrefix}-3`,
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: childId,
      count: 10,
      now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });
    const reviews = await listProductivityReviews(seeded.companyId);

    expect(result.created).toBe(0);
    expect(reviews).toHaveLength(1);
  });

  it("treats a recently completed review as a snooze window", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
    });
    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);
    await db
      .update(issues)
      .set({ status: "done", updatedAt: now })
      .where(eq(issues.id, review!.id));

    const result = await service.reconcileProductivityReviews({
      now: new Date(now.getTime() + 30 * 60 * 1000),
      companyId: seeded.companyId,
    });
    const reviews = await listProductivityReviews(seeded.companyId);

    expect(result.snoozed).toBe(1);
    expect(reviews).toHaveLength(1);
  });

  it("treats a recently cancelled review as a snooze window", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
    });
    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);
    await db
      .update(issues)
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(issues.id, review!.id));

    const result = await service.reconcileProductivityReviews({
      now: new Date(now.getTime() + 30 * 60 * 1000),
      companyId: seeded.companyId,
    });
    const reviews = await listProductivityReviews(seeded.companyId);

    expect(result.snoozed).toBe(1);
    expect(result.created).toBe(0);
    expect(reviews).toHaveLength(1);
  });

  it("reports and logs soft-stop holds for open no-comment reviews", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const [latestRun] = await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
    });
    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);

    const hold = await service.isProductivityReviewContinuationHoldActive({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      agentId: seeded.coderId,
      now,
    });
    expect(hold.held).toBe(true);
    if (!hold.held) return;

    await service.recordContinuationHold({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      runId: latestRun!.id as string,
      agentId: seeded.coderId,
      reviewIssueId: review!.id,
      trigger: hold.trigger,
      reason: hold.reason,
    });
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_continuation_held"));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.entityId).toBe(seeded.issueId);
  });

  it("honors resolvedSnoozeMs when the prior review was cancelled, not just done", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    const cancelledReviewCreatedAt = new Date(now.getTime() - 30 * 60 * 1000);
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      title: "Cancelled productivity review (manager closed as harness noise)",
      status: "cancelled",
      priority: "high",
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      parentId: seeded.issueId,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt: cancelledReviewCreatedAt,
      updatedAt: cancelledReviewCreatedAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.snoozed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);
  });

  it("backs off when the same source issue has two terminal productivity reviews in 24h", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId: seeded.companyId,
        title: "First repeated productivity review",
        status: "done",
        priority: "high",
        originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
        originId: seeded.issueId,
        originFingerprint: `productivity-review:${seeded.issueId}`,
        parentId: seeded.issueId,
        issueNumber: 2,
        identifier: `${seeded.issuePrefix}-2`,
        createdAt: new Date(now.getTime() - 23 * 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 23 * 60 * 60 * 1000),
      },
      {
        id: randomUUID(),
        companyId: seeded.companyId,
        title: "Second repeated productivity review",
        status: "done",
        priority: "high",
        originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
        originId: seeded.issueId,
        originFingerprint: `productivity-review:${seeded.issueId}`,
        parentId: seeded.issueId,
        issueNumber: 3,
        identifier: `${seeded.issuePrefix}-3`,
        createdAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
      },
    ]);

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.snoozed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(2);
  });

  it("does not file a review when 100% of sampling-window runs are routine-origin", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      contextSource: "routine.dispatch",
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("throttles refresh-evidence comments at the 5-minute hard floor (BLO-3281 AC2)", async () => {
    // Reproduces the 2026-05-05 BLO-3277 incident shape: detector
    // re-runs faster than 5 min apart should NOT keep adding refresh
    // comments. PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS gates the
    // addComment call inside createOrUpdateReview.
    //
    // The throttle compares the freshly-generated evidence's wall-clock
    // time to the DB-side createdAt of the latest refresh comment, both
    // of which are real-now in production. To exercise both branches in
    // a unit test without sleeping for 5 min, we backdate the latest
    // refresh comment via SQL UPDATE between scans.
    const seeded = await seedAssignedIssue();
    const scanNow = new Date();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: scanNow,
    });

    const service = productivityReviewService(db);
    const first = await service.reconcileProductivityReviews({ now: scanNow, companyId: seeded.companyId });
    expect(first.created).toBe(1);

    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    const reviewId = reviews[0]!.id;

    async function countRefreshComments() {
      const rows = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, reviewId),
            sql`${issueComments.body} like ${`${PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX}%`}`,
          ),
        );
      return rows.length;
    }

    const baselineRefreshCount = await countRefreshComments();
    expect(baselineRefreshCount).toBe(0);

    // Backdate the review creation so the next scan reaches the refresh
    // branch. Use a one-millisecond configured interval below; the service's
    // five-minute hard floor must still be the effective throttle.
    await db
      .update(issues)
      .set({ createdAt: new Date(Date.now() - PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS - 60 * 1000) })
      .where(eq(issues.id, reviewId));
    const firstRefresh = await service.reconcileProductivityReviews({
      now: new Date(),
      companyId: seeded.companyId,
      thresholds: { refreshIntervalMs: 1 },
    });
    expect(firstRefresh.updated).toBe(1);
    expect(await countRefreshComments()).toBe(1);

    // Within-floor re-scan: latest refresh just landed seconds ago.
    // Throttle should kick in — return existing, no new refresh comment.
    const throttled = await service.reconcileProductivityReviews({
      now: new Date(),
      companyId: seeded.companyId,
      thresholds: { refreshIntervalMs: 1 },
    });
    expect(throttled.existing).toBe(1);
    expect(throttled.updated).toBe(0);
    expect(await countRefreshComments()).toBe(1);

    // Backdate the latest refresh comment so the next reconcile sees
    // it as past the 5-min floor; throttle should release.
    const backdate = new Date(Date.now() - PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS - 60 * 1000);
    await db
      .update(issueComments)
      .set({ createdAt: backdate })
      .where(eq(issueComments.issueId, reviewId));

    const allowed = await service.reconcileProductivityReviews({
      now: new Date(),
      companyId: seeded.companyId,
      thresholds: { refreshIntervalMs: 1 },
    });
    expect(allowed.updated).toBe(1);
    expect(await countRefreshComments()).toBe(2);
  });

  it("serializes concurrent refresh attempts — only one refresh comment per 5min window", async () => {
    // BLO-3737. The throttle above is correct for *sequential* re-scans, but
    // the check and the append were two separate statements: two reconciles
    // overlapping in time both read count=0 / lastRefreshAt=old before either
    // wrote, so both passed the gate and both appended. That is the BLO-3277
    // shape — 14 refresh comments in 6 minutes from the 30s scheduler
    // overlapping itself. createOrUpdateReview now holds a transaction-scoped
    // advisory lock on the review issue across check-then-append, so the
    // loser blocks until the winner commits and then observes its comment.
    const seeded = await seedAssignedIssue();
    const scanNow = new Date();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: scanNow,
    });

    const created = await productivityReviewService(db).reconcileProductivityReviews({
      now: scanNow,
      companyId: seeded.companyId,
    });
    expect(created.created).toBe(1);

    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    const reviewId = reviews[0]!.id;

    async function countRefreshComments() {
      const rows = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, reviewId),
            sql`${issueComments.body} like ${`${PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX}%`}`,
          ),
        );
      return rows.length;
    }

    expect(await countRefreshComments()).toBe(0);

    // Backdate the review creation so BOTH concurrent scans would otherwise
    // reach the refresh branch — without the lock this races.
    await db
      .update(issues)
      .set({ createdAt: new Date(Date.now() - PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS - 60 * 1000) })
      .where(eq(issues.id, reviewId));

    // Separate service instances, as two overlapping scheduler runs would be.
    const [first, second] = await Promise.all([
      productivityReviewService(db).reconcileProductivityReviews({
        now: new Date(),
        companyId: seeded.companyId,
        thresholds: { refreshIntervalMs: 1 },
      }),
      productivityReviewService(db).reconcileProductivityReviews({
        now: new Date(),
        companyId: seeded.companyId,
        thresholds: { refreshIntervalMs: 1 },
      }),
    ]);

    // The whole point: exactly one refresh comment, not two.
    expect(await countRefreshComments()).toBe(1);
    expect(first.updated + second.updated).toBe(1);
    expect(first.existing + second.existing).toBe(1);
    expect(first.failed + second.failed).toBe(0);
  });

  it("clamps poisoned requestDepth metadata instead of aborting productivity reconciliation", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();

    await db
      .update(issues)
      .set({ requestDepth: 2_147_483_647 })
      .where(eq(issues.id, seeded.issueId));

    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.failed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.requestDepth).toBe(MAX_ISSUE_REQUEST_DEPTH);
  });
});
