import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRelations,
  issueWorkProducts,
  issues,
  plugins,
  pluginState,
  projects,
  workspaceOperations,
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
import { PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST } from "../services/pull-request-work-products.js";
import { terminalGateResolutionIdempotencyKey } from "../services/terminal-gate-reconciler.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres productivity review tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

describeEmbeddedPostgres("productivity review service", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-productivity-review-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(plugins);
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

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
    monitorScheduledBy?: "assignee" | "board" | "manager" | null;
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

  // BLO-22436: inserts a `blocks` edge so the source issue has an unresolved
  // blocker (unless `blockerStatus: "done"`, which resolves it).
  async function addBlocker(input: {
    companyId: string;
    issuePrefix: string;
    blockedIssueId: string;
    blockerStatus?: "todo" | "done";
    executionWorkspaceId?: string;
  }) {
    const blockerId = randomUUID();
    const createdAt = new Date("2026-04-28T09:00:00.000Z");
    await db.insert(issues).values({
      id: blockerId,
      companyId: input.companyId,
      title: "Blocking issue",
      status: input.blockerStatus ?? "todo",
      priority: "medium",
      originKind: "manual",
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      issueNumber: 900,
      identifier: `${input.issuePrefix}-900`,
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(issueRelations).values({
      companyId: input.companyId,
      issueId: blockerId,
      relatedIssueId: input.blockedIssueId,
      type: "blocks",
    });
    return blockerId;
  }

  async function insertRuns(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    count: number;
    now: Date;
    withRunComments?: boolean;
    contextSource?: string;
    status?: string;
    startedAt?: Date | null;
    // Derived from `createdAt` (i.e. `now`) by default, which is wrong for any
    // fixture that back-dates `startedAt`: the run then spans the whole episode
    // and B1 reads it as 100% executing time. Set explicitly to model a run that
    // both started AND ended in the past.
    finishedAt?: Date | null;
    nextAction?: string | null;
    livenessState?: string | null;
    usageJson?: Record<string, unknown> | null;
    logBytes?: number | null;
    logStore?: string | null;
    // BLO-26165 (narrowing): the DB default, matching production
    // (`heartbeat_runs.issue_comment_status` defaults to `"not_applicable"`).
    // The original BLO-26165 fix defaulted this to `"retry_exhausted"` instead,
    // deliberately off the production default, so that fixtures would not be
    // swept up by the `issueCommentStatus` exclusion. That made the whole suite
    // model a run population production never produces — and hid the false
    // negative that exclusion introduced. The exclusion now keys on
    // `isNeverInvokedRun` (run telemetry) rather than this column, so fixtures
    // can carry the honest default again.
    issueCommentStatus?: string;
    // Wake reason written into `contextSnapshot`. Production stamps
    // `issueCommentStatus: "not_applicable"` for every reason outside the
    // four-item `shouldRequireIssueCommentForWake` whitelist — and also
    // whenever `contextSnapshot.skipIssueComment === true`, a fifth early exit
    // that makes the required set narrower than the wake list alone.
    wakeReason?: string;
    errorCode?: string | null;
    spacingMs?: number;
  }) {
    const runs: Array<typeof heartbeatRuns.$inferInsert> = [];
    for (let index = 0; index < input.count; index += 1) {
      const runId = randomUUID();
      const createdAt = new Date(input.now.getTime() - index * (input.spacingMs ?? 60_000));
      runs.push({
        id: runId,
        companyId: input.companyId,
        agentId: input.agentId,
        status: input.status ?? "succeeded",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: input.startedAt === undefined ? createdAt : input.startedAt,
        finishedAt:
          input.finishedAt !== undefined
            ? input.finishedAt
            : (input.status ?? "succeeded") === "succeeded"
              ? new Date(createdAt.getTime() + 30_000)
              : null,
        contextSnapshot: {
          issueId: input.issueId,
          taskId: input.issueId,
          ...(input.contextSource ? { source: input.contextSource } : {}),
          ...(input.wakeReason ? { wakeReason: input.wakeReason } : {}),
        },
        livenessState: input.livenessState !== undefined ? input.livenessState : "advanced",
        usageJson: input.usageJson !== undefined ? input.usageJson : undefined,
        errorCode: input.errorCode !== undefined ? input.errorCode : undefined,
        logBytes: input.logBytes !== undefined ? input.logBytes : undefined,
        // BLO-26165: default to a run that HAS a log store, because production
        // only produces the null shape for a pre-adapter failure. `logStore`
        // and `logRef` are written immediately after `runLogStore.begin`, the
        // first thing `executeRun`'s inner `try` does — so every run that got
        // as far as the adapter has them set, and only a setup failure that
        // threw earlier leaves them null.
        //
        // This default is load-bearing for `isNeverInvokedRun`, which reads
        // `logStore`/`logRef` as its invocation signal. Leaving it null made
        // the baseline fixture — a `succeeded` run with `livenessState:
        // "advanced"` — indistinguishable from a run whose adapter never
        // existed, so every ordinary silent-streak test would have been
        // silently excluded from the numerator. Fixtures that mean "never
        // invoked" pass `logStore: null` explicitly.
        //
        // No other predicate reads `logStore`: `isInfraFailureRun` keys on
        // `livenessState`/`usageJson`/`logBytes`, so this default does not
        // disturb the never-executed or runtime-failure populations.
        logStore: input.logStore !== undefined ? input.logStore : "s3",
        issueCommentStatus: input.issueCommentStatus ?? "not_applicable",
        nextAction: input.nextAction === undefined ? "Continue processing the next batch." : input.nextAction,
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

  async function insertProductivityReview(input: {
    seeded: Awaited<ReturnType<typeof seedAssignedIssue>>;
    reviewId?: string;
    createdAt: Date;
    issueNumber?: number | null;
    identifier?: string | null;
    sourceAgentId?: string | null;
  }) {
    const reviewId = input.reviewId ?? randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: input.seeded.companyId,
      title: "Review productivity for reserved source",
      description: "Reserved before identifier allocation",
      status: "todo",
      priority: "medium",
      parentId: input.seeded.issueId,
      assigneeAgentId: input.seeded.managerId,
      createdByAgentId: input.sourceAgentId ?? input.seeded.coderId,
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: input.seeded.issueId,
      originFingerprint: `productivity-review:${input.seeded.issueId}`,
      requestDepth: 1,
      issueNumber: input.issueNumber ?? null,
      identifier: input.identifier ?? null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      lastActivityAt: input.createdAt,
    });
    return reviewId;
  }

  async function countReviewActivity(reviewId: string, action: string) {
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, reviewId),
          eq(activityLog.action, action),
        ),
      )
      .then((rows) => Number(rows[0]?.count ?? 0));
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
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 10");

    expect(await listRefreshComments(reviews[0]!.id)).toHaveLength(0);
  });

  // BLO-19566 AC4. The productivity reviewer's verdict criteria ask for "a
  // non-stale PR/MR link in the source issue's evidence", but collectEvidence
  // never queried one, so an assignee pushing commits to an open PR produced an
  // evidence pack indistinguishable from an idle issue. BLO-19541 misfired on
  // exactly this: it reported "0/6h runs, none recorded" while PR #806 had
  // commits from that same morning.
  describe("pull-request evidence (BLO-19566)", () => {
    async function seedIssueWithPullRequest(opts: {
      /**
       * PEN-3219: the PR title is what decides attribution for a row carrying
       * no recorded `owningIdentifiers`. Defaults to a title naming the seeded
       * issue — i.e. what a PR actually doing this row's work looks like.
       * Pass a title naming some other identifier to seed the counterfeit
       * signal: a PR attached to this row only because it mentioned it.
       */
      title?: string;
      prUpdatedAt: Date;
      status?: string;
      metadata?: Record<string, unknown> | null;
      url?: string | null;
      createdByRunId?: string | null;
      issue?: Parameters<typeof seedAssignedIssue>[0];
    }) {
      const seeded = await seedAssignedIssue(opts.issue);
      await db.insert(issueWorkProducts).values({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        type: "pull_request",
        provider: "github",
        externalId: "Blockcast/paperclip#806",
        title: opts.title ?? `Widen the authz grant (${seeded.issuePrefix}-1)`,
        url: opts.url === undefined ? "https://github.com/Blockcast/paperclip/pull/806" : opts.url,
        status: opts.status ?? "ready_for_review",
        metadata: opts.metadata === undefined
          ? { source: "github_pull_request_webhook", sourceEventOrder: 10 }
          : opts.metadata,
        sourceTrust: PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST,
        createdByRunId: opts.createdByRunId ?? null,
        createdAt: opts.prUpdatedAt,
        updatedAt: opts.prUpdatedAt,
      });
      return seeded;
    }

    it("surfaces a recently-pushed PR instead of reporting zero progress signal", async () => {
      const now = new Date("2026-04-30T12:00:00.000Z");
      // Pushed 2h ago -- inside the 6h window the AC names.
      const seeded = await seedIssueWithPullRequest({
        prUpdatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });

      const service = productivityReviewService(db);
      await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const reviews = await listProductivityReviews(seeded.companyId);
      expect(reviews).toHaveLength(1);
      const description = reviews[0]?.description ?? "";
      // The regression this guards: the line used to be absent entirely.
      expect(description).toContain("Linked pull request:");
      expect(description).toContain("https://github.com/Blockcast/paperclip/pull/806");
      expect(description).toContain("non-stale");
      expect(description).not.toContain("Linked pull request: none recorded");
      // And the manager is told the PR satisfies the second verdict criterion,
      // so a live PR is not read as "no concrete progress signal".
      expect(description).toContain("The second signal is already present");
    });

    it("counts a fresh draft PR as concrete progress", async () => {
      const now = new Date("2026-04-30T12:00:00.000Z");
      const seeded = await seedIssueWithPullRequest({
        prUpdatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        status: "draft",
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });

      const service = productivityReviewService(db);
      await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const description = (await listProductivityReviews(seeded.companyId))[0]?.description ?? "";
      expect(description).toContain("`draft`");
      expect(description).toContain("progress-eligible");
      expect(description).toContain("The second signal is already present");
    });

    it("does not count a freshly closed unmerged PR as concrete progress", async () => {
      const now = new Date("2026-04-30T12:00:00.000Z");
      const seeded = await seedIssueWithPullRequest({
        prUpdatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        status: "closed",
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });

      const service = productivityReviewService(db);
      await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const description = (await listProductivityReviews(seeded.companyId))[0]?.description ?? "";
      expect(description).toContain("Linked pull request:");
      expect(description).toContain("`closed`");
      expect(description).toContain("non-stale");
      expect(description).toContain("not progress-eligible");
      expect(description).not.toContain("The second signal is already present");
    });

    it("lets an older fresh progress PR satisfy the signal when a newer closed PR exists", async () => {
      const now = new Date("2026-04-30T12:00:00.000Z");
      const seeded = await seedIssueWithPullRequest({
        prUpdatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      });
      await db.insert(issueWorkProducts).values({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        type: "pull_request",
        provider: "github",
        externalId: "Blockcast/paperclip#807",
        title: "Closed unmerged follow-up",
        url: "https://github.com/Blockcast/paperclip/pull/807",
        status: "closed",
        metadata: { source: "github_pull_request_webhook", sourceEventOrder: 20 },
        sourceTrust: PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST,
        createdAt: new Date(now.getTime() - 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 60 * 60 * 1000),
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });

      const service = productivityReviewService(db);
      await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const description = (await listProductivityReviews(seeded.companyId))[0]?.description ?? "";
      expect(description).toContain("https://github.com/Blockcast/paperclip/pull/806");
      expect(description).toContain("`ready_for_review`");
      expect(description).toContain("The second signal is already present");
      expect(description).not.toContain("https://github.com/Blockcast/paperclip/pull/807");
    });

    it("counts a freshly merged PR as concrete progress", async () => {
      const now = new Date("2026-04-30T12:00:00.000Z");
      const seeded = await seedIssueWithPullRequest({
        prUpdatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        status: "merged",
        metadata: { source: "github_pull_request_webhook", sourceEventOrder: 30 },
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });

      const service = productivityReviewService(db);
      await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const description = (await listProductivityReviews(seeded.companyId))[0]?.description ?? "";
      expect(description).toContain("`merged`");
      expect(description).toContain("The second signal is already present");
    });

    // PEN-3219. A `pull_request` work product is written for EVERY issue a PR
    // references anywhere, so a long-lived registry/invariant row accumulates
    // every PR that name-drops it. Before this, the most recently *touched*
    // member of that pile became the row's progress signal and the review told
    // its reviewer "the second signal is already present" — on PEN-2370, a
    // `critical` row dark for seven days carrying 44 such rows, none its own.
    //
    // NOTE for anyone adding a case here: the rendered phrase "attributed to
    // this issue" is a SUBSTRING of "NOT attributed to this issue", so a lone
    // `toContain("attributed to this issue")` passes on an unattributed PR.
    // Always pair it with `not.toContain("NOT attributed to this issue")`.
    describe("attribution of the linked PR (PEN-3219)", () => {
      // The measured PEN-3216 shape: the row's ONLY fresh progress-eligible PR
      // is titled for, owned by, and driven from a different issue.
      it("does not count a fresh progress PR that belongs to another issue", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedIssueWithPullRequest({
          prUpdatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          title: "feat(security): scope run-transcript reads to own-run (ZZQ-3142)",
        });
        await insertRuns({
          companyId: seeded.companyId,
          agentId: seeded.coderId,
          issueId: seeded.issueId,
          count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
          now,
        });

        const service = productivityReviewService(db);
        await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

        const description = (await listProductivityReviews(seeded.companyId))[0]?.description ?? "";
        // The PR is still SHOWN — suppressing it would hide real information —
        // but it no longer licenses the verdict.
        expect(description).toContain("https://github.com/Blockcast/paperclip/pull/806");
        expect(description).toContain("NOT attributed to this issue");
        expect(description).not.toContain("The second signal is already present");
        // And the reviewer is told why, rather than left to infer it from a
        // line that still looks like progress.
        expect(description).toContain("A linked PR moved recently, but it is NOT attributed to this issue");
        expect(description).toContain("Do not treat it as grounds for \"Close as productive\"");
      });

      // The counterfeit signal must not shadow a real one: an unattributed PR
      // that moved more recently cannot hide this row's own fresh PR.
      it("picks this issue's own PR over a newer one belonging to another issue", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedIssueWithPullRequest({
          prUpdatedAt: new Date(now.getTime() - 5 * 60 * 60 * 1000),
        });
        await db.insert(issueWorkProducts).values({
          companyId: seeded.companyId,
          issueId: seeded.issueId,
          type: "pull_request",
          provider: "github",
          externalId: "Blockcast/paperclip#1741",
          title: "feat(security): scope run-transcript reads to own-run (ZZQ-3142)",
          url: "https://github.com/Blockcast/paperclip/pull/1741",
          status: "ready_for_review",
          metadata: { source: "github_pull_request_webhook", sourceEventOrder: 10 },
          sourceTrust: PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST,
          createdAt: new Date(now.getTime() - 60 * 60 * 1000),
          updatedAt: new Date(now.getTime() - 60 * 60 * 1000),
        });
        await insertRuns({
          companyId: seeded.companyId,
          agentId: seeded.coderId,
          issueId: seeded.issueId,
          count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
          now,
        });

        const service = productivityReviewService(db);
        await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

        const description = (await listProductivityReviews(seeded.companyId))[0]?.description ?? "";
        expect(description).toContain("The second signal is already present");
        expect(description).toContain("https://github.com/Blockcast/paperclip/pull/806");
        expect(description).not.toContain("https://github.com/Blockcast/paperclip/pull/1741");
      });

      // The attributed PR must be found however many unattributed PRs moved
      // after it. An earlier revision paged the candidates 25 at a time before
      // filtering for ownership, so a registry row name-dropped by 25 PRs
      // inside one day would have had its own PR pushed off the page and read
      // as "no second signal" — the false-negative twin of the PEN-3216 bug.
      it("finds this issue's own PR behind 30 newer PRs belonging to other issues", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedIssueWithPullRequest({
          prUpdatedAt: new Date(now.getTime() - 5 * 60 * 60 * 1000),
        });
        await db.insert(issueWorkProducts).values(
          Array.from({ length: 30 }, (_, i) => {
            const touchedAt = new Date(now.getTime() - (60 - i) * 60 * 1000);
            return {
              companyId: seeded.companyId,
              issueId: seeded.issueId,
              type: "pull_request",
              provider: "github",
              externalId: `Blockcast/paperclip#${2000 + i}`,
              title: `feat(other): unrelated work that mentions this row (ZZQ-${3000 + i})`,
              url: `https://github.com/Blockcast/paperclip/pull/${2000 + i}`,
              status: "ready_for_review",
              metadata: { source: "github_pull_request_webhook", sourceEventOrder: 10 + i },
              sourceTrust: PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST,
              createdAt: touchedAt,
              updatedAt: touchedAt,
            };
          }),
        );
        await insertRuns({
          companyId: seeded.companyId,
          agentId: seeded.coderId,
          issueId: seeded.issueId,
          count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
          now,
        });

        const service = productivityReviewService(db);
        await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

        const description = (await listProductivityReviews(seeded.companyId))[0]?.description ?? "";
        expect(description).toContain("The second signal is already present");
        expect(description).toContain("https://github.com/Blockcast/paperclip/pull/806");
        expect(description).not.toContain("NOT attributed to this issue");
      });

      // The webhook records the resolved owning set at write time, which is the
      // only way a PR that claims its issue solely in a labeled BODY line can be
      // recognised here — the row never stores the body.
      it("attributes by the recorded owning set, not just the title", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedIssueWithPullRequest({
          prUpdatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          title: "chore: no identifier in this title at all",
        });
        await db
          .update(issueWorkProducts)
          .set({
            metadata: {
              source: "github_pull_request_webhook",
              sourceEventOrder: 10,
              owningIdentifiers: [`${seeded.issuePrefix}-1`],
            },
          })
          .where(eq(issueWorkProducts.issueId, seeded.issueId));
        await insertRuns({
          companyId: seeded.companyId,
          agentId: seeded.coderId,
          issueId: seeded.issueId,
          count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
          now,
        });

        const service = productivityReviewService(db);
        await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

        const description = (await listProductivityReviews(seeded.companyId))[0]?.description ?? "";
        expect(description).toContain("attributed to this issue");
        expect(description).not.toContain("NOT attributed to this issue");
        expect(description).toContain("The second signal is already present");
      });

      // A recorded EMPTY set is authoritative — the PR named no owner anywhere,
      // so it is attributable to nothing. Only a missing key means "unknown"
      // and falls back to deriving from the fields the row carries.
      it("treats a recorded empty owning set as attributable to nothing", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedIssueWithPullRequest({
          prUpdatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        });
        await db
          .update(issueWorkProducts)
          .set({
            metadata: {
              source: "github_pull_request_webhook",
              sourceEventOrder: 10,
              owningIdentifiers: [],
            },
          })
          .where(eq(issueWorkProducts.issueId, seeded.issueId));
        await insertRuns({
          companyId: seeded.companyId,
          agentId: seeded.coderId,
          issueId: seeded.issueId,
          count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
          now,
        });

        const service = productivityReviewService(db);
        await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

        const description = (await listProductivityReviews(seeded.companyId))[0]?.description ?? "";
        expect(description).toContain("NOT attributed to this issue");
        expect(description).not.toContain("The second signal is already present");
      });

      // Legacy rows (written before the owning set was recorded) fall back to
      // the tiers the row still carries. The branch is one of them, and real
      // branches are lowercase where the identifier pattern is uppercase-only.
      it("attributes a legacy row by its lowercase branch", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedIssueWithPullRequest({
          prUpdatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          title: "chore: no identifier in this title at all",
        });
        await db
          .update(issueWorkProducts)
          .set({
            metadata: {
              source: "github_pull_request_webhook",
              sourceEventOrder: 10,
              branch: `cto/${seeded.issuePrefix.toLowerCase()}-1-widen-grant`,
            },
          })
          .where(eq(issueWorkProducts.issueId, seeded.issueId));
        await insertRuns({
          companyId: seeded.companyId,
          agentId: seeded.coderId,
          issueId: seeded.issueId,
          count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
          now,
        });

        const service = productivityReviewService(db);
        await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

        const description = (await listProductivityReviews(seeded.companyId))[0]?.description ?? "";
        expect(description).toContain("attributed to this issue");
        expect(description).not.toContain("NOT attributed to this issue");
        expect(description).toContain("The second signal is already present");
      });
    });

    it("reads a delayed first delivery as stale by GitHub event time, not DB receipt time", async () => {
      // A first webhook delivery can land long after the PR event (retry,
      // backfill, outage drain). The row then inserts with `updatedAt = now`,
      // so aging off `updatedAt` advertises an already-dead PR as fresh
      // progress for another 24h. Age must come from the GitHub event time.
      const now = new Date("2026-04-30T12:00:00.000Z");
      const seeded = await seedAssignedIssue();
      const threeDaysAgoMs = now.getTime() - 3 * 24 * 60 * 60 * 1000;
      await db.insert(issueWorkProducts).values({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        type: "pull_request",
        provider: "github",
        externalId: "Blockcast/paperclip#806",
        title: `Widen the authz grant (${seeded.issuePrefix}-1)`,
        url: "https://github.com/Blockcast/paperclip/pull/806",
        status: "ready_for_review",
        metadata: {
          source: "github_pull_request_webhook",
          sourceEventOrder: 10,
          sourceEventTimestamp: new Date(threeDaysAgoMs).toISOString(),
          sourceEventTimestampMs: threeDaysAgoMs,
        },
        sourceTrust: PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST,
        createdByRunId: null,
        // Receipt time is "now" -- the delayed delivery.
        createdAt: now,
        updatedAt: now,
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });

      const service = productivityReviewService(db);
      await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const description = (await listProductivityReviews(seeded.companyId))[0]?.description ?? "";
      const prLine = description.split("\n").find((line) => line.includes("Linked pull request:")) ?? "";
      expect(prLine).not.toBe("");
      // Aged from the GitHub event time (3d), not the "now" receipt time.
      // Asserted on the PR line specifically: the manager's verdict criteria
      // quote the phrase "non-stale" too, so a whole-description match would
      // pass regardless of what this line says.
      expect(prLine).toContain("2026-04-27T12:00:00.000Z");
      expect(prLine).toContain(", stale,");
      expect(prLine).not.toContain("non-stale");
      expect(description).not.toContain("The second signal is already present");
    });

    it("ignores actor-authored GitHub PR rows without webhook provenance", async () => {
      const now = new Date("2026-04-30T12:00:00.000Z");
      const seeded = await seedAssignedIssue();
      const runs = await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });
      await db.insert(issueWorkProducts).values({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        type: "pull_request",
        provider: "github",
        externalId: "Blockcast/paperclip#806",
        title: "Actor-authored PR claim",
        url: "https://github.com/Blockcast/paperclip/pull/806",
        status: "ready_for_review",
        metadata: { source: "manual" },
        createdByRunId: runs[0]?.id ?? null,
        createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      });

      const service = productivityReviewService(db);
      await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const description = (await listProductivityReviews(seeded.companyId))[0]?.description ?? "";
      expect(description).toContain("Linked pull request: none recorded");
      expect(description).not.toContain("The second signal is already present");
    });

    it("ignores rows that spoof webhook metadata without server provenance", async () => {
      const now = new Date("2026-04-30T12:00:00.000Z");
      const seeded = await seedAssignedIssue();
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });
      await db.insert(issueWorkProducts).values({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        type: "pull_request",
        provider: "github",
        externalId: "Blockcast/paperclip#806",
        title: "Spoofed webhook PR claim",
        url: "https://github.com/Blockcast/paperclip/pull/806",
        status: "ready_for_review",
        metadata: { source: "github_pull_request_webhook", sourceEventOrder: 10 },
        sourceTrust: null,
        createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      });

      const service = productivityReviewService(db);
      await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const description = (await listProductivityReviews(seeded.companyId))[0]?.description ?? "";
      expect(description).toContain("Linked pull request: none recorded");
      expect(description).not.toContain("The second signal is already present");
    });

    it("ignores webhook PR rows that do not carry an inspectable URL", async () => {
      const now = new Date("2026-04-30T12:00:00.000Z");
      const seeded = await seedIssueWithPullRequest({
        prUpdatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        url: null,
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });

      const service = productivityReviewService(db);
      await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const description = (await listProductivityReviews(seeded.companyId))[0]?.description ?? "";
      expect(description).toContain("Linked pull request: none recorded");
      expect(description).not.toContain("The second signal is already present");
    });

    it("marks a PR that has not moved in over 24h as stale", async () => {
      const now = new Date("2026-04-30T12:00:00.000Z");
      const seeded = await seedIssueWithPullRequest({
        prUpdatedAt: new Date(now.getTime() - 30 * 60 * 60 * 1000),
      });
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
      });

      const service = productivityReviewService(db);
      await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

      const description = (await listProductivityReviews(seeded.companyId))[0]?.description ?? "";
      expect(description).toContain("Linked pull request:");
      expect(description).toContain("stale");
      // A stale PR must NOT be advertised as satisfying the verdict criterion.
      expect(description).not.toContain("The second signal is already present");
    });

    it("still reports none recorded when the issue genuinely has no PR", async () => {
      const now = new Date("2026-04-30T12:00:00.000Z");
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

      const description = (await listProductivityReviews(seeded.companyId))[0]?.description ?? "";
      expect(description).toContain("Linked pull request: none recorded");
    });

    // BLO-27698 A1. Until now `isProgressPullRequest` had exactly one caller, in
    // `buildReviewMarkdown` — the evidence pack could say "the second signal is
    // already present" on a review that should never have been generated. These
    // assert NON-generation, which is what makes them new coverage over the
    // rendering tests above.
    describe("long-active suppression by a fresh progress PR (BLO-27698 A1)", () => {
      // The BLO-27207 fixture: episode long past `longActiveMs`, PR pushed 6h13m
      // ago (well inside the 24h bar), and no Paperclip-side comment recency to
      // save it. This fired a false positive on master.
      it("does not generate a long-active review while a fresh progress PR exists", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedIssueWithPullRequest({
          prUpdatedAt: new Date(now.getTime() - (6 * 60 + 13) * 60 * 1000),
          issue: {
            status: "in_progress",
            startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
          },
        });

        const result = await productivityReviewService(db).reconcileProductivityReviews({
          now,
          companyId: seeded.companyId,
        });

        expect(result.created).toBe(0);
        expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
      });

      // BLO-22331 AC2 boundedness guard: the suppression must lapse on its own.
      // A PR that stopped moving 30h ago is outside PRODUCTIVITY_REVIEW_PR_FRESH_MS,
      // so the trigger fires again rather than being held off indefinitely.
      it("still fires once the PR ages past the freshness window", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedIssueWithPullRequest({
          prUpdatedAt: new Date(now.getTime() - 30 * 60 * 60 * 1000),
          issue: {
            status: "in_progress",
            startedAt: new Date(now.getTime() - 31 * 60 * 60 * 1000),
          },
        });

        const result = await productivityReviewService(db).reconcileProductivityReviews({
          now,
          companyId: seeded.companyId,
        });

        expect(result.created).toBe(1);
        const [review] = await listProductivityReviews(seeded.companyId);
        expect(review?.description).toContain("Primary trigger: `long_active_duration`");
      });

      // Keys on progress-eligibility, not mere freshness: a PR the assignee
      // closed without merging is not progress, however recently it moved. Proves
      // the gate reads `isProgressPullRequest`, not `isFreshPullRequest`.
      it("still fires for a fresh but closed-unmerged PR", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedIssueWithPullRequest({
          prUpdatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          status: "closed",
          issue: {
            status: "in_progress",
            startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
          },
        });

        const result = await productivityReviewService(db).reconcileProductivityReviews({
          now,
          companyId: seeded.companyId,
        });

        expect(result.created).toBe(1);
        const [review] = await listProductivityReviews(seeded.companyId);
        expect(review?.description).toContain("Primary trigger: `long_active_duration`");
      });
    });

    // BLO-27698 A2: an issue the assignee filed against this one is deliverable
    // progress. Every case below asserts non-generation (or generation), never
    // that a line was rendered — the defect this AC closes is precisely a signal
    // that was computed and printed but never consulted.
    describe("a fresh assignee-filed linked issue (A2)", () => {
      async function seedLinkedIssue(opts: {
        companyId: string;
        createdByAgentId: string | null;
        createdAt: Date;
        parentId?: string | null;
        blockedByIssueId?: string | null;
      }) {
        const linkedId = randomUUID();
        await db.insert(issues).values({
          id: linkedId,
          companyId: opts.companyId,
          title: "Decomposed: wire the adapter",
          status: "todo",
          parentId: opts.parentId ?? null,
          createdByAgentId: opts.createdByAgentId,
          createdAt: opts.createdAt,
          updatedAt: opts.createdAt,
        });
        if (opts.blockedByIssueId) {
          // `type: "blocks"` reads issueId -> relatedIssueId, so this is
          // "the source blocks the new issue".
          await db.insert(issueRelations).values({
            companyId: opts.companyId,
            issueId: opts.blockedByIssueId,
            relatedIssueId: linkedId,
            type: "blocks",
            createdByAgentId: opts.createdByAgentId,
            createdAt: opts.createdAt,
            updatedAt: opts.createdAt,
          });
        }
        return linkedId;
      }

      it("does not generate a long-active review while a fresh sub-issue exists", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedAssignedIssue({
          status: "in_progress",
          startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
        });
        await seedLinkedIssue({
          companyId: seeded.companyId,
          createdByAgentId: seeded.coderId,
          createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          parentId: seeded.issueId,
        });

        const result = await productivityReviewService(db).reconcileProductivityReviews({
          now,
          companyId: seeded.companyId,
        });

        expect(result.created).toBe(0);
        expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
      });

      // The second arm of the structural OR, and it is not redundant with the
      // first: an assignee that files follow-up work and records the dependency
      // writes an `issue_relations` edge and NO `parentId`.
      //
      // Edge direction is deliberate and load-bearing. It is the SOURCE that
      // blocks the new issue, not the reverse. An unresolved blocker pointing AT
      // the source would make the source dependency-blocked, and generation
      // already skips those outright (`productivity-review.ts:5071-5073`,
      // BLO-22436) — so that fixture would go green without A2's gate existing at
      // all. Which is also the honest scope note for this AC: the "block with an
      // unblock owner" shape needs no gate here, because it is already exempt.
      it("does not generate while a fresh relation-linked issue exists, with no parent link", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedAssignedIssue({
          status: "in_progress",
          startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
        });
        await seedLinkedIssue({
          companyId: seeded.companyId,
          createdByAgentId: seeded.coderId,
          createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          parentId: null,
          blockedByIssueId: seeded.issueId,
        });

        const result = await productivityReviewService(db).reconcileProductivityReviews({
          now,
          companyId: seeded.companyId,
        });

        expect(result.created).toBe(0);
      });

      // BLO-22331 AC2 boundedness guard. The episode bound alone does not bound
      // anything — an episode grows without limit — so this proves the 24h
      // freshness intersection is what actually makes the suppression lapse.
      it("still fires once the linked issue ages past the freshness window", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedAssignedIssue({
          status: "in_progress",
          startedAt: new Date(now.getTime() - 31 * 60 * 60 * 1000),
        });
        await seedLinkedIssue({
          companyId: seeded.companyId,
          createdByAgentId: seeded.coderId,
          createdAt: new Date(now.getTime() - 30 * 60 * 60 * 1000),
          parentId: seeded.issueId,
        });

        const result = await productivityReviewService(db).reconcileProductivityReviews({
          now,
          companyId: seeded.companyId,
        });

        expect(result.created).toBe(1);
        const [review] = await listProductivityReviews(seeded.companyId);
        expect(review?.description).toContain("Primary trigger: `long_active_duration`");
      });

      // Negative control for the reference test. An assignee filing unrelated
      // work in the same company is not progress on THIS issue; without a
      // structural edge the gate must not engage. Guards against the cheap
      // implementation that counts any issue the agent created.
      it("still fires for a fresh assignee-created issue that does not reference the source", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedAssignedIssue({
          status: "in_progress",
          startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
        });
        await seedLinkedIssue({
          companyId: seeded.companyId,
          createdByAgentId: seeded.coderId,
          createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          parentId: null,
        });

        const result = await productivityReviewService(db).reconcileProductivityReviews({
          now,
          companyId: seeded.companyId,
        });

        expect(result.created).toBe(1);
      });

      // The creator is load-bearing too: a linked issue somebody ELSE filed says
      // nothing about whether the assignee is working.
      it("still fires when the linked issue was created by another agent", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedAssignedIssue({
          status: "in_progress",
          startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
        });
        await seedLinkedIssue({
          companyId: seeded.companyId,
          createdByAgentId: seeded.managerId,
          createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          parentId: seeded.issueId,
        });

        const result = await productivityReviewService(db).reconcileProductivityReviews({
          now,
          companyId: seeded.companyId,
        });

        expect(result.created).toBe(1);
      });

      // The defect this gate almost shipped with, pinned directly rather than
      // left to the three `assignment wake` replay tests that happened to catch
      // it. A productivity review row is written as a CHILD of its source issue
      // with `createdByAgentId` set to the assignee, so a naive "assignee filed a
      // linked issue" predicate scores the review itself as progress — and the
      // detector switches itself off 24h after firing once. Fixture mirrors the
      // real row: same parent + creator as A2's positive case, differing only in
      // `originKind`.
      it("does not count a generated productivity review as the assignee's progress", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedAssignedIssue({
          status: "in_progress",
          startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
        });
        await insertProductivityReview({
          seeded,
          createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          issueNumber: 2,
          identifier: `${seeded.issuePrefix}-2`,
        });

        const result = await productivityReviewService(db).reconcileProductivityReviews({
          now,
          companyId: seeded.companyId,
        });

        expect(result.created).toBe(1);
      });
    });

    // BLO-27698 A3: the rubric has told reviewers for three releases that a
    // run-linked `Next action:` comment in the last 6h means "close as
    // productive". These assert that code now applies the same criterion.
    describe("a fresh run-linked `Next action:` comment (A3)", () => {
      async function seedNextActionComment(opts: {
        companyId: string;
        issueId: string;
        agentId: string;
        createdAt: Date;
        runLinked: boolean;
        now: Date;
        episodeStartAt?: Date;
      }) {
        const [run] = opts.runLinked
          ? await insertRuns({
            companyId: opts.companyId,
            agentId: opts.agentId,
            issueId: opts.issueId,
            count: 1,
            now: opts.now,
            nextAction: null,
            // Anchored to the episode start, and this is load-bearing rather
            // than cosmetic. `activeStartedAt` takes `max(run.startedAt)` when
            // that is at or after the episode start, so a run stamped `now` —
            // `insertRuns`'s default — resets the episode clock and collapses
            // `elapsedMs` to 0. `long_active_duration` then cannot fire at all,
            // and every assertion here would pass without the A3 gate existing:
            // the suppression cases vacuously, the "still fires" cases not at
            // all. A3 is the one AC whose signal REQUIRES a run, so it is the
            // one place this bites.
            //
            // BLO-27698 B1/B3: `finishedAt` must be pinned too. Left to default
            // it lands at `now + 30s`, so the run spans the whole episode, the
            // executing bucket swallows `elapsedMs`, `unattendedMs` collapses to
            // ~0, and `long_active_duration` cannot fire for a reason that has
            // nothing to do with A3. Anchor the episode with a SHORT run.
            startedAt: opts.episodeStartAt ?? opts.now,
            finishedAt: new Date((opts.episodeStartAt ?? opts.now).getTime() + 30_000),
          })
          : [null];
        await db.insert(issueComments).values({
          companyId: opts.companyId,
          issueId: opts.issueId,
          authorAgentId: opts.agentId,
          createdByRunId: run?.id ?? null,
          body: "Rebased onto master.\n\nNext action: land the migration once CI clears.",
          createdAt: opts.createdAt,
          updatedAt: opts.createdAt,
        });
      }

      // Non-vacuity control for the suppression case below, and the reason it
      // exists: the identical fixture minus the comment MUST generate. Without
      // this, a fixture whose episode clock had collapsed would report
      // `created: 0` for a reason having nothing to do with A3, and the
      // suppression test would pass while asserting nothing.
      it("control: the same fixture with no next-action comment still fires", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const episodeStartAt = new Date(now.getTime() - 7 * 60 * 60 * 1000);
        const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStartAt });
        await insertRuns({
          companyId: seeded.companyId,
          agentId: seeded.coderId,
          issueId: seeded.issueId,
          count: 1,
          now,
          nextAction: null,
          startedAt: episodeStartAt,
          // BLO-27698 B1/B3: short run at the anchor — see `seedNextActionComment`.
          finishedAt: new Date(episodeStartAt.getTime() + 30_000),
          withRunComments: true,
        });

        const result = await productivityReviewService(db).reconcileProductivityReviews({
          now,
          companyId: seeded.companyId,
        });

        expect(result.created).toBe(1);
        const [review] = await listProductivityReviews(seeded.companyId);
        expect(review?.description).toContain("Primary trigger: `long_active_duration`");
      });

      it("does not generate a long-active review over a fresh run-linked next action", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedAssignedIssue({
          status: "in_progress",
          startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
        });
        await seedNextActionComment({
          companyId: seeded.companyId,
          issueId: seeded.issueId,
          agentId: seeded.coderId,
          createdAt: new Date(now.getTime() - 60 * 60 * 1000),
          runLinked: true,
          now,
          episodeStartAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
        });

        const result = await productivityReviewService(db).reconcileProductivityReviews({
          now,
          companyId: seeded.companyId,
        });

        expect(result.created).toBe(0);
        expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
      });

      // BLO-22331 AC2 boundedness guard: stop commenting and the trigger returns.
      it("still fires once the next-action comment ages past the 6h window", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedAssignedIssue({
          status: "in_progress",
          startedAt: new Date(now.getTime() - 9 * 60 * 60 * 1000),
        });
        await seedNextActionComment({
          companyId: seeded.companyId,
          issueId: seeded.issueId,
          agentId: seeded.coderId,
          createdAt: new Date(now.getTime() - (6 * 60 + 30) * 60 * 1000),
          runLinked: true,
          now,
          episodeStartAt: new Date(now.getTime() - 9 * 60 * 60 * 1000),
        });

        const result = await productivityReviewService(db).reconcileProductivityReviews({
          now,
          companyId: seeded.companyId,
        });

        expect(result.created).toBe(1);
      });

      // The rubric says "run-linked", so the gate must too. An unlinked comment
      // is still REPORTED (the `Current next action:` fallback exists precisely
      // to recover it) but is not evidence that a turn happened — so this asserts
      // both halves: the review fires, and the line is printed anyway.
      it("still fires for an unlinked next-action comment, while still reporting it", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedAssignedIssue({
          status: "in_progress",
          startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
        });
        await seedNextActionComment({
          companyId: seeded.companyId,
          issueId: seeded.issueId,
          agentId: seeded.coderId,
          createdAt: new Date(now.getTime() - 60 * 60 * 1000),
          runLinked: false,
          now,
        });

        const result = await productivityReviewService(db).reconcileProductivityReviews({
          now,
          companyId: seeded.companyId,
        });

        expect(result.created).toBe(1);
        const [review] = await listProductivityReviews(seeded.companyId);
        expect(review?.description).toContain("land the migration once CI clears");
      });

      // The decoupling itself, which is the half of A3 that is not a gate.
      // Raising the trigger bar to 12h must NOT widen the evidence lookback: a
      // 7h-old comment is stale at any bar. Before the split, one constant fed
      // both, so this fixture would have suppressed.
      it("does not widen the comment lookback when `longActiveMs` is raised", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const seeded = await seedAssignedIssue({
          status: "in_progress",
          startedAt: new Date(now.getTime() - 13 * 60 * 60 * 1000),
        });
        await seedNextActionComment({
          companyId: seeded.companyId,
          issueId: seeded.issueId,
          agentId: seeded.coderId,
          createdAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
          runLinked: true,
          now,
          episodeStartAt: new Date(now.getTime() - 13 * 60 * 60 * 1000),
        });

        const result = await productivityReviewService(db).reconcileProductivityReviews({
          now,
          companyId: seeded.companyId,
          thresholds: { longActiveMs: 12 * 60 * 60 * 1000 },
        });

        expect(result.created).toBe(1);
      });

      // The other half of the decoupling, and the direction the first version
      // missed: LOWERING `longActiveMs` must not let a PRE-EPISODE comment
      // suppress. `longActiveMs` has no lower clamp, so at a 1-minute bar the
      // fixed 6h evidence window is 360x the trigger bar — without intersecting
      // it with the episode, a `Next action:` from a *previous* episode on the
      // same issue suppresses every review of the current one, indefinitely
      // (BLO-22331 AC2). The comment here is run-linked and inside 6h, so the
      // ONLY thing that can make this fire is the episode-start clamp.
      it("does not let a pre-episode next-action comment suppress when `longActiveMs` is lowered", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const episodeStartAt = new Date(now.getTime() - 10 * 60 * 1000);
        const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStartAt });
        await seedNextActionComment({
          companyId: seeded.companyId,
          issueId: seeded.issueId,
          agentId: seeded.coderId,
          // Before the episode began, but well inside the 6h evidence window.
          createdAt: new Date(now.getTime() - 3 * 60 * 60 * 1000),
          runLinked: true,
          now,
          episodeStartAt,
        });

        const result = await productivityReviewService(db).reconcileProductivityReviews({
          now,
          companyId: seeded.companyId,
          thresholds: { longActiveMs: 60_000 },
        });

        expect(result.created).toBe(1);
        const [review] = await listProductivityReviews(seeded.companyId);
        expect(review?.description).toContain("Primary trigger: `long_active_duration`");
      });

      // `runLinked` is a property of the WINDOW, not of the newest comment. The
      // rubric asks whether *a* run-linked comment exists in the last 6h, so a
      // later unlinked comment — an out-of-band note, a human-triggered edit —
      // must not mask an earlier run-linked one and flip the gate off. Read off
      // the newest row alone this fixture generates a review against an assignee
      // that posted exactly the artifact the rubric asks for.
      it("suppresses on a run-linked comment masked by a newer unlinked one", async () => {
        const now = new Date("2026-04-30T12:00:00.000Z");
        const episodeStartAt = new Date(now.getTime() - 7 * 60 * 60 * 1000);
        const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStartAt });
        await seedNextActionComment({
          companyId: seeded.companyId,
          issueId: seeded.issueId,
          agentId: seeded.coderId,
          createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          runLinked: true,
          now,
          episodeStartAt,
        });
        await seedNextActionComment({
          companyId: seeded.companyId,
          issueId: seeded.issueId,
          agentId: seeded.coderId,
          // Newer, and NOT run-linked — the masking comment.
          createdAt: new Date(now.getTime() - 60 * 60 * 1000),
          runLinked: false,
          now,
        });

        const result = await productivityReviewService(db).reconcileProductivityReviews({
          now,
          companyId: seeded.companyId,
        });

        expect(result.created).toBe(0);
        expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
      });
    });
  });

  // BLO-21769: a run that crashlooped, hit an upstream 503 storm, was killed
  // by provider capacity limits, or exhausted its retry budget never got a
  // model turn. It must not be counted as "the agent ran and stayed silent" —
  // it should surface as its own infra-owned trigger instead.
  it("surfaces a streak of terminal never-executed runs under `runtime_failure_streak`, not `no_comment_streak` (BLO-21769)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      status: "failed",
      livenessState: "failed",
      usageJson: null,
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.description).toContain("Primary trigger: `runtime_failure_streak`");
    expect(reviews[0]?.description).not.toContain("Primary trigger: `no_comment_streak`");
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 0");
    expect(reviews[0]?.description).toContain("Runtime-failure streak (terminal, never-executed runs): 10");
    expect(reviews[0]?.description).toContain("Route to platform/SRE");
    expect(reviews[0]?.description).not.toContain("Request decomposition");
  });

  it("excludes never-executed runs from the no-comment streak without breaking it — real silent completions still trip it (BLO-21769)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    // Most recent 3 runs never executed (infra failure). Older 10 runs
    // genuinely succeeded and produced no comment. Pre-fix, all 13 terminal
    // runs would count toward noCommentStreak. Post-fix, the 3 never-executed
    // runs are skipped and the streak is measured over the 10 executed runs.
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 3,
      now,
      status: "failed",
      livenessState: "failed",
      usageJson: null,
    });
    const olderNow = new Date(now.getTime() - 4 * 60_000);
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: olderNow,
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 10");
    expect(reviews[0]?.description).toContain("Runtime-failure streak (terminal, never-executed runs): 3");
  });

  // PEN-3442 AMENDS BLO-21769. This test used to assert that a failed,
  // token-bearing run COUNTS toward `no_comment_streak`. That is the defect
  // PEN-3442 filed: the run executed, burned tokens, and was killed before it
  // could post — provider fault, not assignee silence.
  //
  // BLO-21769's actual invariant is untouched and still asserted below: a
  // token-bearing failure is NOT never-executed, so it must not reach
  // `runtime_failure_streak`. That trigger is the platform-owner-facing
  // infrastructure signal and feeding it billed, productive runs would be the
  // wrong fix for this defect. Only the inference "it executed, therefore its
  // silence is the assignee's" is withdrawn.
  it("keeps a failed run that produced token usage out of BOTH streaks — executed, but killed before it could comment (BLO-21769 / PEN-3442)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    // Older: a genuine silent streak, so a review exists to read and the
    // assertion is a number rather than an absence. Pre-fix this read 20.
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: new Date(now.getTime() - 90 * 60 * 1000),
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      status: "failed",
      livenessState: "failed",
      usageJson: { inputTokens: 500, outputTokens: 200 },
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 10");
    // BLO-21769's surviving invariant: a token-bearing failure is not
    // never-executed, so it stays out of the infrastructure trigger.
    expect(reviews[0]?.description).toContain("Runtime-failure streak (terminal, never-executed runs): 0");
    // …and PEN-3442's: it is accounted for in its own bucket, not silently dropped.
    expect(reviews[0]?.description).toContain(
      "Fault-terminated runs excluded (terminal, executed a turn then killed before finishing it — `status: failed`, PEN-3442): 10",
    );
  });

  // BLO-26165 / BLO-23096: the 25-run `preferred_workspace_unrealizable`
  // streak that produced the false-positive review this issue was opened for.
  // Nothing capable of writing a comment ever existed, so the assignee-facing
  // `no_comment_streak` must not fire.
  //
  // What DOES fire — correctly — is `runtime_failure_streak`. These rows are
  // terminal, `livenessState: "failed"`, zero-token infra failures, which is
  // exactly that trigger's population. It is the platform-owner-facing signal,
  // and its own body says "infrastructure signal, not an agent-performance
  // verdict; do not decompose, block, or cancel the underlying work on the
  // strength of this alone." Asserting `created === 0` here would only be
  // reachable with a `livenessState: null` fixture that production never
  // writes for a terminal setup failure. The acceptance criterion is that no
  // *`no_comment_streak`* review is created, not that the window goes unreported.
  it("attributes the BLO-23096 never-invoked streak to runtime_failure_streak, never to no_comment_streak (BLO-26165)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    // Anchored 2h before `now` (outside the 1h/6h high_churn windows) so the
    // fixture cannot trip `high_churn` and muddy which trigger won.
    const insertNow = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    // Production shape for a `preferred_workspace_unrealizable` pre-adapter
    // throw. `livenessState` is "failed", NOT null: the setup-failure branch of
    // `executeRun`'s outer catch calls `classifyAndPersistRunLiveness`, and
    // `classifyRunLiveness` returns "failed" for any non-succeeded run.
    // `usageJson`/`logStore`/`logRef` stay null because the throw precedes
    // `runLogStore.begin`.
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 25,
      now: insertNow,
      status: "failed",
      errorCode: "preferred_workspace_unrealizable",
      livenessState: "failed",
      usageJson: null,
      logBytes: null,
      logStore: null,
      issueCommentStatus: "not_applicable",
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    // The assignee-facing trigger must not be the one that fired.
    expect(reviews[0]?.description).toContain("Primary trigger: `runtime_failure_streak`");
    expect(reviews[0]?.description).not.toContain("Primary trigger: `no_comment_streak`");
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 0");
    // Proves the invocation predicate is live against the production row shape:
    // a predicate that short-circuits on non-null `livenessState` reports 0.
    expect(reviews[0]?.description).toContain(
      "Never-invoked runs excluded (terminal, no adapter ever created — `usageJson`/`logStore`/`logRef` null, `logBytes` null or 0, BLO-26165): 25",
    );
  });

  // BLO-26165 NEGATIVE CONTROL (required). This is the test that fails against
  // the first BLO-26165 fix (#1342) and must keep passing after it.
  //
  // #1342 excluded on `issueCommentStatus === "not_applicable"`, treating it as
  // proof no adapter ran. It is not: `finalizeIssueCommentPolicy` stamps that
  // status on runs that provably executed, whenever
  // `shouldRequireIssueCommentForWake` returns false. That helper is a
  // four-item wake-reason whitelist (`issue_assigned`,
  // `execution_review_requested`, `execution_approval_requested`,
  // `execution_changes_requested`) behind a fifth early exit for
  // `contextSnapshot.skipIssueComment === true`, so an
  // `issue_monitor_due` run — like every `heartbeat_timer`,
  // `issue_comment_mentioned`, `issue_continuation_needed` and recovery-lane
  // run — gets `not_applicable` no matter how much work it did. Under #1342 the
  // streak below reads 0 and the detector is silent while an agent burns
  // 10 consecutive wakes without a word. That is the inverse of the false
  // positive BLO-26165 was opened for, and it disables the detector on the
  // overwhelming majority of wake reasons.
  //
  // These runs carry positive proof of invocation: a real usage blob, a log
  // store, and non-zero log bytes.
  it("counts executed runs stamped issueCommentStatus: not_applicable toward the streak — comment policy is not an invocation signal (BLO-26165 negative control)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      wakeReason: "issue_monitor_due",
      issueCommentStatus: "not_applicable",
      livenessState: "advanced",
      usageJson: { inputTokens: 4200, outputTokens: 1350 },
      logBytes: 512_000,
      logStore: "s3",
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(reviews[0]?.description).toContain(
      `No-comment streak (terminal, turn-executing runs): ${DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS}`,
    );
    // The label must not claim these were never invoked — they were.
    expect(reviews[0]?.description).toContain(
      "Never-invoked runs excluded (terminal, no adapter ever created — `usageJson`/`logStore`/`logRef` null, `logBytes` null or 0, BLO-26165): 0",
    );
    expect(reviews[0]?.description).toContain(
      `Comment-policy-exempt runs that DID execute (terminal, \`issueCommentStatus: not_applicable\`, not excluded from the streak walk — BLO-26165): ${DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS}`,
    );
  });

  it("still fires no_comment_streak on a streak of executed, comment-required-but-missed runs (BLO-26165 control)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      issueCommentStatus: "retry_exhausted",
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 10");
    expect(reviews[0]?.description).toContain(
      "Never-invoked runs excluded (terminal, no adapter ever created — `usageJson`/`logStore`/`logRef` null, `logBytes` null or 0, BLO-26165): 0",
    );
  });

  // PEN-3442. The defect: `no_comment_streak` counted runs that executed a
  // turn, burned tokens, and were then killed by a provider fault before
  // reaching the point where a run posts its issue comment. To the detector
  // those are indistinguishable from an agent working steadily and declining
  // to report; they are the opposite — work destroyed in flight.
  //
  // The fixture is the production shape measured on PEN-1990 (CEO, 2026-09-22;
  // re-measured live 2026-09-24): terminal `failed` runs carrying
  // `rate_limit_exhausted`, `livenessState: "failed"`, and NON-ZERO tokens.
  // That last field is what makes them leak — `isInfraFailureRun` requires zero
  // tokens, so `isNeverExecutedRun` does not catch them and they land in the
  // streak numerator. The filed identity was exact: the card's "12 consecutive
  // …" was precisely the 12 billed `rate_limit_exhausted` runs, $28.69 and
  // 87,474 output tokens of destroyed work.
  //
  // Seeded alongside a genuine silent streak so the assertion is a number
  // rather than an absence, and so it pins the exclusion as *transparent* to
  // the walk (it continues through to the older runs) rather than a
  // streak-breaker. Breaking there would assert "the assignee commented here",
  // which is exactly what did not happen.
  it("excludes runs killed mid-turn by a provider fault from no_comment_streak, without breaking the walk (PEN-3442)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    // Anchored outside the 1h/6h high_churn windows so the fixture cannot trip
    // `high_churn` and muddy which trigger won.
    const insertNow = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    // Older: a genuine silent streak. These executed, finished their turn, and
    // did not comment — real assignee silence, and the streak that must
    // survive the fix.
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: new Date(insertNow.getTime() - 60 * 60 * 1000),
    });
    // Most recent: the PEN-1990 shape. Token counts are a real measured row
    // (2026-09-22T10:25:45Z, 319 KB of log) — substantial work, none committed.
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 12,
      now: insertNow,
      status: "failed",
      errorCode: "rate_limit_exhausted",
      livenessState: "failed",
      usageJson: { inputTokens: 3399, outputTokens: 5846 },
      logBytes: 230_532,
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    // The 12 fault-terminated runs are excluded, and the walk continues past
    // them to the 10 genuinely silent ones. Pre-fix this read 22.
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 10");
    expect(reviews[0]?.description).toContain(
      "Fault-terminated runs excluded (terminal, executed a turn then killed before finishing it — `status: failed`, PEN-3442): 12",
    );
    // They are NOT the never-invoked population: these got an adapter and used
    // it. A fix that folded the two together would report 12 here.
    expect(reviews[0]?.description).toContain(
      "Never-invoked runs excluded (terminal, no adapter ever created — `usageJson`/`logStore`/`logRef` null, `logBytes` null or 0, BLO-26165): 0",
    );
    // …and they are not infrastructure telemetry either: `runtime_failure_streak`
    // keys on zero tokens, and these burned some. Pinning this is what stops a
    // future widening from "fixing" this defect by feeding billed, productive
    // runs to the platform-owner-facing trigger instead.
    expect(reviews[0]?.description).toContain("Runtime-failure streak (terminal, never-executed runs): 0");
  });

  // PEN-3442, generality. The defect was filed on `rate_limit_exhausted`, but
  // the leak is not that error code — it is "executed, then killed". Measured
  // on PEN-1990 live (2026-09-24), a `claude_transient_upstream` run burned
  // 32,805 output tokens across 1.3 MB of log before dying, and counted toward
  // the same streak.
  //
  // This is the test that fails against the narrower fix the issue offered as
  // its first option (an `errorCode` allowlist seeded from the filed table):
  // any such list would have had to predict this member. Keying on
  // `livenessState` catches it without enumerating anything.
  it("excludes a fault-terminated run whatever the provider error code (PEN-3442 generality)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const insertNow = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: new Date(insertNow.getTime() - 60 * 60 * 1000),
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 12,
      now: insertNow,
      status: "failed",
      errorCode: "claude_transient_upstream",
      livenessState: "failed",
      usageJson: { inputTokens: 12_154, outputTokens: 32_805 },
      logBytes: 1_304_478,
    });

    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 10");
    expect(reviews[0]?.description).toContain(
      "Fault-terminated runs excluded (terminal, executed a turn then killed before finishing it — `status: failed`, PEN-3442): 12",
    );
  });

  // PEN-3442 NEGATIVE CONTROL (required). The exclusion must not be able to
  // empty the trigger: a fault-terminated run is excluded, but a run that
  // executed, FINISHED, and stayed silent is still assignee behaviour and must
  // still accumulate. Without this, a predicate that also caught ordinary
  // silent runs would pass the two tests above while deleting the detector.
  // The two tests after this one pin the other edges: `timed_out`/`cancelled`
  // stay in the walk, and a fault-terminated run that commented still breaks it.
  //
  // The fixture is the production-faithful default (`succeeded` /
  // `livenessState: "advanced"`).
  it("still fires no_comment_streak on executed runs that finished and stayed silent (PEN-3442 control)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      usageJson: { inputTokens: 3399, outputTokens: 5846 },
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews[0]?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 10");
    expect(reviews[0]?.description).toContain(
      "Fault-terminated runs excluded (terminal, executed a turn then killed before finishing it — `status: failed`, PEN-3442): 0",
    );
  });

  // PEN-3442 scope. `livenessState: "failed"` is every non-succeeded terminal
  // status, so a liveness-only predicate also excluded `timed_out` and
  // `cancelled` runs. Those had their turn and stayed silent through it, which
  // is exactly what this streak reports. Under the liveness-only predicate this
  // fixture reads 8 and does not fire.
  it("keeps timed-out and cancelled silent runs in the no_comment_streak walk (PEN-3442 scope)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const insertNow = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS - 2,
      now: new Date(insertNow.getTime() - 60 * 60 * 1000),
    });
    for (const [offsetMs, status] of [[0, "timed_out"], [5 * 60 * 1000, "cancelled"]] as const) {
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: 1,
        now: new Date(insertNow.getTime() - offsetMs),
        status,
        livenessState: "failed",
        usageJson: { inputTokens: 3399, outputTokens: 5846 },
        logBytes: 230_532,
      });
    }

    await productivityReviewService(db).reconcileProductivityReviews({ now, companyId: seeded.companyId });

    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 10");
    expect(reviews[0]?.description).toContain(
      "Fault-terminated runs excluded (terminal, executed a turn then killed before finishing it — `status: failed`, PEN-3442): 0",
    );
  });

  // PEN-3442 and comment evidence. `commentRunIds` holds every comment a run
  // authored, so a fault-terminated run can have commented mid-turn. Newest
  // first: 5 silent runs, one `rate_limit_exhausted` run that commented, then
  // 10 older silent runs. The commenting run must break the walk at 5; if it
  // were excluded like a silent fault-terminated run the streak would read 15
  // and fire against an agent that demonstrably reported.
  it("lets a fault-terminated run that commented still break no_comment_streak (PEN-3442)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const insertNow = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: new Date(insertNow.getTime() - 60 * 60 * 1000),
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 1,
      now: new Date(insertNow.getTime() - 10 * 60 * 1000),
      status: "failed",
      errorCode: "rate_limit_exhausted",
      livenessState: "failed",
      usageJson: { inputTokens: 3399, outputTokens: 5846 },
      logBytes: 230_532,
      withRunComments: true,
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 5,
      now: insertNow,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("distinguishes never-invoked runs from executed-but-silent runs in the same sampled window (BLO-26165)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    // Most recent 5 runs never invoked (adapter never started). Production
    // shape: `livenessState: "failed"` — see the BLO-23096 fixture above. This
    // is what makes the assertion below a real regression test: a predicate
    // that short-circuits on non-null `livenessState` reports 0 here, not 5.
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 5,
      now,
      status: "failed",
      errorCode: "preferred_workspace_unrealizable",
      livenessState: "failed",
      usageJson: null,
      logBytes: null,
      logStore: null,
      issueCommentStatus: "not_applicable",
    });
    // Older 10 runs genuinely executed and stayed silent.
    const olderNow = new Date(now.getTime() - 6 * 60_000);
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: olderNow,
      issueCommentStatus: "retry_exhausted",
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 10");
    expect(reviews[0]?.description).toContain(
      "Never-invoked runs excluded (terminal, no adapter ever created — `usageJson`/`logStore`/`logRef` null, `logBytes` null or 0, BLO-26165): 5",
    );
  });

  // BLO-26165: the branch where `isNeverInvokedRun` is load-bearing rather than
  // a subset of `isNeverExecutedRun`. Liveness classification is not guaranteed
  // to land on a setup failure — the write in the outer catch is gated on the
  // run still being `running`, and `backfillMissingRunLivenessForIssue` is
  // scheduled asynchronously — so `livenessState: null` is reachable on a
  // terminal never-invoked run. `isInfraFailureRun` requires
  // `livenessState === "failed"` and therefore returns false for these rows;
  // without the invocation predicate they would walk straight into the streak
  // and fire a review against an assignee that was never invoked.
  it("excludes never-invoked runs whose liveness classification never landed, which isInfraFailureRun cannot catch (BLO-26165)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    // Anchored outside the 1h/6h high_churn windows so a suppressed
    // no_comment_streak doesn't simply trip a different trigger.
    const insertNow = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: insertNow,
      status: "failed",
      errorCode: "preferred_workspace_unrealizable",
      livenessState: null,
      usageJson: null,
      logBytes: null,
      logStore: null,
      issueCommentStatus: "not_applicable",
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(0);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(0);
  });

  // BLO-22097: a post-model failure whose result event never arrives leaves
  // `usageJson: null` even though the model produced output — null usage is
  // unknown, not a measured zero. `logBytes` far above the boilerplate-only
  // ceiling corroborates that a turn actually ran, so the run must NOT be
  // dropped from the walk as never-executed.
  //
  // PEN-3442 AMENDS the conclusion, not the premise. BLO-22097 established
  // that the turn ran; it then treated "ran" as sufficient for "the assignee
  // was silent". A `claude_truncated` run is killed mid-turn by definition, so
  // it never reached the comment checkpoint. It is still not never-executed —
  // asserted below — it is fault-terminated.
  it("keeps a claude_truncated-shaped run (null usage, high logBytes) out of BOTH streaks (BLO-22097 / PEN-3442)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: new Date(now.getTime() - 90 * 60 * 1000),
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      status: "failed",
      livenessState: "failed",
      usageJson: null,
      logBytes: 844_801,
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 10");
    expect(reviews[0]?.description).toContain("Runtime-failure streak (terminal, never-executed runs): 0");
    expect(reviews[0]?.description).toContain(
      "Fault-terminated runs excluded (terminal, executed a turn then killed before finishing it — `status: failed`, PEN-3442): 10",
    );
  });

  // BLO-22097 positive control: a large log does not override an *explicit*
  // measured zero. 111,337 bytes is the largest confirmed-zero-usage log
  // observed across the BLO-19924/BLO-21091/BLO-21025 samples — `logBytes`
  // must not promote this run out of never-executed just because it is big.
  it("still excludes an explicit-zero-usage run from the no-comment streak even at the 111,337-byte logBytes boundary (BLO-22097 positive control)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      status: "failed",
      livenessState: "failed",
      usageJson: { inputTokens: 0, outputTokens: 0 },
      logBytes: 111_337,
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.description).toContain("Primary trigger: `runtime_failure_streak`");
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 0");
    expect(reviews[0]?.description).toContain("Runtime-failure streak (terminal, never-executed runs): 10");
  });

  // BLO-22097 positive control: null usage plus null logBytes (never
  // dispatched / crashlooped before any log was captured) must keep
  // classifying as never-executed — the #1041 false-positive fix must not
  // regress just because the corroboration path is new.
  it("still excludes a null-usage, null-logBytes crashloop run from the no-comment streak (BLO-22097 positive control)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      status: "failed",
      livenessState: "failed",
      usageJson: null,
      logBytes: null,
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.description).toContain("Primary trigger: `runtime_failure_streak`");
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 0");
    expect(reviews[0]?.description).toContain("Runtime-failure streak (terminal, never-executed runs): 10");
    // BLO-22097 Ally follow-up: usage was never recorded for this run — the
    // evidence must not claim a measured "0 input/output tokens".
    expect(reviews[0]?.description).toContain(
      "usage telemetry unavailable — low/missing log volume consistent with no model turn",
    );
    expect(reviews[0]?.description).not.toContain("0 input/output tokens");
    // BLO-22097 Ally follow-up: an inferred basis must not assert the
    // definitive "produced zero model turns" / "never given a chance to act"
    // claims — those are only true for a measured basis. The trigger reason
    // and Manager Decision text must both use hedged wording instead.
    expect(reviews[0]?.description).toContain(
      "consecutive terminal runs show no evidence of a model turn",
    );
    expect(reviews[0]?.description).not.toContain("produced zero model turns");
    expect(reviews[0]?.description).toContain(
      "consistent with the assignee never being given a chance to act, though missing usage telemetry means this cannot be confirmed",
    );
    expect(reviews[0]?.description).not.toContain("the assignee was never given a chance to act.");
  });

  // BLO-22097 Ally follow-up: a streak that mixes an explicit measured zero
  // with missing-usage runs must report the "mixed" basis, and the
  // trigger/manager-facing claims must stay hedged (not the definitive
  // "measured" wording) since not every run in the streak is actually
  // measured.
  it("reports a mixed usage basis with hedged wording for a streak mixing measured-zero and inferred runs (BLO-22097)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const streak = DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS;
    const runs: Array<typeof heartbeatRuns.$inferInsert> = [];
    for (let index = 0; index < streak; index += 1) {
      const createdAt = new Date(now.getTime() - index * 60_000);
      runs.push({
        id: randomUUID(),
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        status: "failed",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 30_000),
        contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
        livenessState: "failed",
        // Alternate between an explicit measured zero and missing usage so
        // the streak walk sees both bases.
        usageJson: index % 2 === 0 ? { inputTokens: 0, outputTokens: 0 } : null,
        logBytes: index % 2 === 0 ? 500 : null,
        nextAction: "Continue processing the next batch.",
        createdAt,
        updatedAt: createdAt,
      });
    }
    await db.insert(heartbeatRuns).values(runs);

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.description).toContain("Primary trigger: `runtime_failure_streak`");
    expect(reviews[0]?.description).toContain(`Runtime-failure streak (terminal, never-executed runs): ${streak}`);
    expect(reviews[0]?.description).toContain(
      "usage telemetry unavailable for some runs (low/missing log volume consistent with no model turn), explicit 0 input/output tokens for the rest",
    );
    expect(reviews[0]?.description).toContain(
      "consecutive terminal runs show no evidence of a model turn",
    );
    expect(reviews[0]?.description).not.toContain("produced zero model turns");
    expect(reviews[0]?.description).toContain(
      "consistent with the assignee never being given a chance to act, though missing usage telemetry means this cannot be confirmed",
    );
    expect(reviews[0]?.description).not.toContain("the assignee was never given a chance to act.");
  });

  // BLO-22097 Ally follow-up: pin the inclusive boundary of
  // `NEVER_EXECUTED_UNKNOWN_USAGE_LOG_BYTES_CEILING` (200,000 bytes) itself,
  // through a null-usage run rather than the explicit-zero-usage boundary
  // control above (which bypasses this comparison entirely).
  it("still excludes a null-usage run from the no-comment streak at the 200,000-byte logBytes ceiling, inclusive (BLO-22097)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      status: "failed",
      livenessState: "failed",
      usageJson: null,
      logBytes: 200_000,
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.description).toContain("Primary trigger: `runtime_failure_streak`");
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 0");
    expect(reviews[0]?.description).toContain("Runtime-failure streak (terminal, never-executed runs): 10");
  });

  // PEN-3442 amends this the same way as the two above: the 200,000-byte
  // ceiling still decides never-executed vs executed — asserted by the
  // `Runtime-failure streak: 0` line — but executing is no longer sufficient
  // to make the silence the assignee's when the run was killed mid-turn.
  it("keeps a null-usage run one byte past the 200,000-byte logBytes ceiling out of BOTH streaks (BLO-22097 / PEN-3442)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: new Date(now.getTime() - 90 * 60 * 1000),
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      status: "failed",
      livenessState: "failed",
      usageJson: null,
      logBytes: 200_001,
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 10");
    expect(reviews[0]?.description).toContain("Runtime-failure streak (terminal, never-executed runs): 0");
    expect(reviews[0]?.description).toContain(
      "Fault-terminated runs excluded (terminal, executed a turn then killed before finishing it — `status: failed`, PEN-3442): 10",
    );
  });

  // BLO-22436: `cancelQueuedRunForBlockedDependencies` (heartbeat.ts) cancels
  // a run before dispatch when the issue has an unresolved blocker. The run
  // never gets classified `failed` liveness (it never ran), so pre-fix it
  // slipped past the BLO-21769 `isInfraFailureRun` filter entirely and
  // extended `noCommentStreak` like a genuine silence. A sample window
  // dominated by these cancellations must not trip any trigger. Runs are
  // spaced 10 minutes apart (not the default 1 minute) so the count alone
  // doesn't cross the unrelated `high_churn` hourly threshold — the point
  // under test is that a long-blocked issue has nothing to no-comment on.
  it("excludes issue_dependencies_blocked cancellations from both streaks and produces no review (BLO-22436)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      spacingMs: 10 * 60_000,
      status: "cancelled",
      livenessState: null,
      usageJson: null,
      // The gate cancels a still-`queued` run, so `executeRun` never opened a
      // log store for it — `logStore`/`logRef` are null in production, same as
      // a pre-adapter setup failure. Stated explicitly because the helper now
      // defaults `logStore` to a run that executed (BLO-26165).
      logStore: null,
      errorCode: "issue_dependencies_blocked",
      // BLO-22436 (Ally follow-up): model the gate's actual write.
      // `cancelQueuedRunForBlockedDependencies` never calls
      // `finalizeIssueCommentPolicy`, so the column stays at its DB default.
      issueCommentStatus: "not_applicable",
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  // BLO-22436: the standard remediation for a flagged platform fault is to
  // model it as a `blockedBy` edge — which, without this gate, guarantees the
  // detector keeps flagging the same issue every cycle it stays blocked. An
  // issue with an unresolved blocker must be exempt on a genuine
  // executed-but-silent streak, not merely on the dependency-gate
  // cancellations of the test above.
  //
  // Runs are spaced 10 minutes apart (Ally follow-up on 37c1bd65): at the
  // default 1-minute spacing 10 silent runs also trip `high_churn`, and the
  // suppression would then be passing on trigger precedence
  // (`choosePrimaryTrigger` ranks `no_comment_streak` first) rather than on
  // the behaviour under test. Wider spacing puts 7 runs in the trailing hour,
  // under `highChurnHourly` (10), and 10 in six hours, under
  // `highChurnSixHours` (30) — so `no_comment_streak` is the only trigger that
  // fires and the whole fired set is dependency-closable. The co-fired case
  // has its own test below.
  it("skips an issue with an unresolved blocker on a genuine executed-but-silent streak (BLO-22436)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      spacingMs: 10 * 60_000,
    });
    await addBlocker({
      companyId: seeded.companyId,
      issuePrefix: seeded.issuePrefix,
      blockedIssueId: seeded.issueId,
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(0);
    // Reported under its own counter, not folded into the generic `skipped`
    // bucket: this ticket exists because the loop was invisible, so the
    // suppression has to be countable on its own.
    expect(result.dependencyBlockedSuppressed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  // BLO-22436 (Ally follow-up on 37c1bd65): the generation gate must weigh the
  // blocker against EVERY trigger that fired, not the primary one.
  // `choosePrimaryTrigger` is a priority ladder, so an agent that is both
  // silent and churning presents `no_comment_streak` — which a blocker does
  // excuse — while carrying `high_churn` evidence underneath, which it does
  // not. Keying the skip on the primary alone left the original evasion intact
  // for exactly the agent worth reviewing, and the defaults make that overlap
  // the norm rather than a corner: `noCommentStreakRuns` and `highChurnHourly`
  // are both 10, and `insertRuns` spaces runs 60s apart, so ten silent runs in
  // ten minutes trip both predicates at once.
  it("still generates a review for a dependency-blocked issue whose silent streak also trips high churn (BLO-22436)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    // Default 60s spacing: 10 runs inside 10 minutes, so `noComment` AND
    // `highChurn` both fire and `choosePrimaryTrigger` returns the former.
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await addBlocker({
      companyId: seeded.companyId,
      issuePrefix: seeded.issuePrefix,
      blockedIssueId: seeded.issueId,
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    expect(result.dependencyBlockedSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    // The primary is still the closable one — the artifact survives because of
    // the non-closable trigger beneath it, and that trigger's evidence is what
    // the review has to carry.
    expect(review?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(review?.description).toContain("runs/0 assignee-run comments in 1h");
  });

  // BLO-22436 (Ally follow-up): the generation gate is scoped to the same
  // trigger set the close path already trusts (`isDependencyBlockedClosableTrigger`).
  // `high_churn` is a record of runs that DID execute and DID burn cost — a
  // blocker added afterwards does not make that untrue. Skipping generation
  // unconditionally would let a flagged agent retire its own
  // cost-accountability artifact one cycle early just by adding a `blockedBy`
  // edge, which is exactly the evasion the close path already refuses (see
  // "does not close an open high-churn review when its source becomes
  // dependency-blocked" below).
  it("still generates a high-churn review for a dependency-blocked issue (BLO-22436)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
      withRunComments: true,
    });
    await addBlocker({
      companyId: seeded.companyId,
      issuePrefix: seeded.issuePrefix,
      blockedIssueId: seeded.issueId,
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    expect(result.dependencyBlockedSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `high_churn`");
  });

  // BLO-22887 AC2: the two cells above are the "still warranted on other
  // grounds" case — BLO-22436 suppresses a dependency-blocked source whose
  // fired set is entirely closable, so *every* blocked source that reaches the
  // body builder is one a blocker does not excuse. Until now the body said
  // nothing about the blocker at all, so a manager read `Elapsed accounting`'s
  // unattended figure with no indication that the control plane independently
  // classified the issue as dependency-blocked — the exact subsystem
  // disagreement this issue was filed for. The line reports blocker STATE and
  // says so: the readiness map carries no edge timestamps, so subtracting an
  // unmeasured span from the wall-clock buckets would swap a known-wrong
  // attribution for an invented one.
  // The full rendered line, not the count prefix: the "reviewed anyway" clause
  // and the caveat are the part a reviewer cannot get from the source issue,
  // and a prefix match passes with both deleted (Ally review, PR #1722).
  const DEPENDENCY_LINE_ONE_BLOCKER =
    "- Dependency accounting: 1 unresolved `blockedBy` blocker at this evidence pass; reviewed anyway because `high_churn` fired, which an unresolved blocker does not excuse — blocker state at this pass, not a measured span: the elapsed figures above are wall-clock and are NOT reduced by this, so dependency-blocked time of unrecorded length is already inside them";
  // Runs dispatched 30m ago: `activeStartedAt` anchors on the latest run
  // `startedAt`, and `insertRuns`'s default (`startedAt = createdAt = now`)
  // reports a 0m episode, which pins nothing.
  const dispatchedThirtyMinutesAgo = (now: Date) => new Date(now.getTime() - 30 * 60 * 1000);
  // BLO-27698 B1: `insertRuns` backdates `startedAt` without backdating
  // `finishedAt`, so these runs' live spans cover the whole episode and the 30m
  // lands in `executing` rather than `unattended`. Both BLO-22887 cells below
  // still pin the *same* split with and without the blocker, which is the
  // property they exist to guard — the dependency bucket is reported beside the
  // elapsed figures, never folded into them. Which bucket carries the 30m is
  // B1's business, not theirs.
  const ELAPSED_LINE_30M_EXECUTING =
    "- Elapsed accounting: 0m monitor-gated, 30m executing, 0m unattended (no monitor armed during this episode)";

  it("reports a dependency-blocked bucket alongside the elapsed split when a review still fires on a non-closable trigger (BLO-22887)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
      withRunComments: true,
      startedAt: dispatchedThirtyMinutesAgo(now),
    });
    await addBlocker({
      companyId: seeded.companyId,
      issuePrefix: seeded.issuePrefix,
      blockedIssueId: seeded.issueId,
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain(DEPENDENCY_LINE_ONE_BLOCKER);
    // Reported next to the elapsed split, never folded into it: the split is
    // byte-identical to the one the resolved-blocker cell below reports with no
    // dependency line at all.
    expect(review?.description).toContain(ELAPSED_LINE_30M_EXECUTING);
  });

  // BLO-22887 AC2 over-reporting guard, and the counterpart to BLO-22436's
  // cell-3 regression guard: an accounting line that renders unconditionally
  // would pass the cell above while telling every reviewer in the fleet that
  // an unblocked issue is dependency-blocked. Keyed on *unresolved*, so a
  // `done` blocker is a stronger control than no edge at all — the edge still
  // exists, and readiness is what decides.
  it("omits the dependency accounting line when the source issue's only blocker is resolved (BLO-22887)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
      withRunComments: true,
      startedAt: dispatchedThirtyMinutesAgo(now),
    });
    await addBlocker({
      companyId: seeded.companyId,
      issuePrefix: seeded.issuePrefix,
      blockedIssueId: seeded.issueId,
      blockerStatus: "done",
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `high_churn`");
    expect(review?.description).not.toContain("Dependency accounting");
    // Same seeding as the cell above minus the unresolved blocker, same
    // elapsed split: the bucket is never subtracted from the wall-clock figures.
    expect(review?.description).toContain(ELAPSED_LINE_30M_EXECUTING);
  });

  // BLO-22887 AC2: a `done` blocker whose execution workspace has not finalized
  // is still unresolved (`listDependencyReadiness`'s workspace-finalize
  // barrier), and the line says which kind it is — the remedy differs (wait
  // for sync-back vs. chase the blocker's assignee).
  it("names the done-but-awaiting-finalize subset in the dependency accounting line (BLO-22887)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
      withRunComments: true,
    });
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: seeded.companyId, name: "Finalize barrier" });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId: seeded.companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Finalize barrier workspace",
    });
    const blockerId = await addBlocker({
      companyId: seeded.companyId,
      issuePrefix: seeded.issuePrefix,
      blockedIssueId: seeded.issueId,
      blockerStatus: "done",
      executionWorkspaceId,
    });
    // The blocker's latest op on its workspace is not a succeeded
    // `workspace_finalize`, so readiness keeps it unresolved.
    await db.insert(workspaceOperations).values({
      companyId: seeded.companyId,
      executionWorkspaceId,
      issueId: blockerId,
      phase: "worktree_prepare",
      status: "succeeded",
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain(
      "- Dependency accounting: 1 unresolved `blockedBy` blocker at this evidence pass (1 `done` but awaiting workspace finalize); reviewed anyway because `high_churn` fired, which an unresolved blocker does not excuse — blocker state at this pass, not a measured span: the elapsed figures above",
    );
  });

  // Ally review (PR #1722): `Elapsed accounting` renders only when
  // `monitorGating` was computed, which needs an `in_progress` source — so
  // every `todo` candidate carries the dependency line with no elapsed split
  // above it (and the refresh comment, which prints no unconditional elapsed
  // figure, with nothing at all). The caveat has to say so rather than point
  // at figures that are not on the page.
  it("does not point the dependency caveat at an elapsed split that was never rendered (BLO-22887)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({ status: "todo" });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
      withRunComments: true,
    });
    await addBlocker({
      companyId: seeded.companyId,
      issuePrefix: seeded.issuePrefix,
      blockedIssueId: seeded.issueId,
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("- Current active elapsed time: unknown");
    expect(review?.description).not.toContain("Elapsed accounting");
    expect(review?.description).toContain(
      "- Dependency accounting: 1 unresolved `blockedBy` blocker at this evidence pass; reviewed anyway because `high_churn` fired, which an unresolved blocker does not excuse — blocker state at this pass, not a measured span: no elapsed split was computed for this episode, so there is no wall-clock figure this reduces",
    );
    expect(review?.description).not.toContain("elapsed figures above");
  });

  // BLO-22887 AC2: the refresh comment is what lands in the manager's
  // notifications, and it already mirrors `Elapsed accounting` /
  // `No-executable-turn accounting` for exactly that reason. A dependency
  // bucket that appeared only in the description would leave the summary
  // telling a different story from the artifact it summarises.
  it("carries the dependency accounting line into the refresh comment (BLO-22887)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
      withRunComments: true,
    });
    await addBlocker({
      companyId: seeded.companyId,
      issuePrefix: seeded.issuePrefix,
      blockedIssueId: seeded.issueId,
    });

    const service = productivityReviewService(db);
    // `high_churn` is the non-closable trigger keeping this review alive, and
    // it reads a rolling 1h window — so the refresh has to land while the
    // seeded runs are still inside it. Shorten the refresh interval to the
    // hard floor and step 6 minutes rather than the 1h default, which would
    // age the runs out and stop generating the review entirely.
    const thresholds = { refreshIntervalMs: PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS };
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId, thresholds });
    const [review] = await listProductivityReviews(seeded.companyId);
    const refreshed = await service.reconcileProductivityReviews({
      now: new Date(now.getTime() + 6 * 60 * 1000),
      companyId: seeded.companyId,
      thresholds,
    });

    expect(refreshed.updated).toBe(1);
    const refreshComments = await listRefreshComments(review!.id);
    expect(refreshComments.length).toBeGreaterThan(0);
    expect(refreshComments.at(-1)?.body).toContain(DEPENDENCY_LINE_ONE_BLOCKER);
  });

  // BLO-22436: once the blocker resolves (or the edge is removed), the same
  // issue is reviewable again, and its historical dependency-blocked
  // cancellations must be reported as their own line item — not folded into
  // `no_comment_streak` (which they're excluded from) or `runtime_failure_streak`
  // (which stays reserved for genuine infra faults) — so the reviewing manager
  // doesn't have to re-derive dispatch health from raw run telemetry.
  it("reports non-executing dependency-blocked runs separately, without inflating either streak, once a review fires for another reason (BLO-22436)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    // 3 most-recent runs: dependency-gate cancellations from when the issue
    // was blocked. The blocker has since resolved (no relation row inserted),
    // so the current-blocker gate does not apply.
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 3,
      now,
      status: "cancelled",
      livenessState: null,
      usageJson: null,
      // The gate cancels a still-`queued` run, so `executeRun` never opened a
      // log store for it — `logStore`/`logRef` are null in production, same as
      // a pre-adapter setup failure. Stated explicitly because the helper now
      // defaults `logStore` to a run that executed (BLO-26165).
      logStore: null,
      errorCode: "issue_dependencies_blocked",
      // BLO-22436 (Ally follow-up): model the gate's actual write (see note above).
      issueCommentStatus: "not_applicable",
    });
    // 10 older runs: genuinely executed and silent.
    const olderNow = new Date(now.getTime() - 4 * 60_000);
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: olderNow,
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 10");
    expect(reviews[0]?.description).toContain("Runtime-failure streak (terminal, never-executed runs): 0");
    expect(reviews[0]?.description).toContain(
      "Never-invoked runs excluded (terminal, no adapter ever created — `usageJson`/`logStore`/`logRef` null, `logBytes` null or 0, BLO-26165): 3",
    );
    // BLO-22436 (Ally follow-up): all 3 non-executing runs are also counted
    // above as never-invoked — the evidence block must say so rather than
    // rendering two adjacent counts that read as independent.
    expect(reviews[0]?.description).toContain(
      "Non-executing runs in sample window (excluded from streaks above): 3 (all 3 already counted above as never-invoked; dominant errorCode: `issue_dependencies_blocked`, all 3)",
    );
  });

  // BLO-22436 (review follow-up): dependency-gate cancellations are transparent
  // to the runtime-failure walk, not streak-breakers — symmetrically with
  // `noCommentStreak`. This is the BLO-20815 ordering: genuine infra failures
  // with newer dependency-gate cancellations layered on top. Breaking the walk
  // on the cancellations would mask the real infra streak behind them, which is
  // precisely the signal a platform owner needs. A cancelled-before-dispatch run
  // is no evidence the runtime was healthy — nothing was attempted.
  it("sees through newer dependency-gate cancellations to a genuine infra-failure streak (BLO-22436)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    // Newest: dependency-gate cancellations. The blocker has since resolved (no
    // relation row), so the generation gate does not apply.
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 3,
      now,
      status: "cancelled",
      livenessState: null,
      usageJson: null,
      // The gate cancels a still-`queued` run, so `executeRun` never opened a
      // log store for it — `logStore`/`logRef` are null in production, same as
      // a pre-adapter setup failure. Stated explicitly because the helper now
      // defaults `logStore` to a run that executed (BLO-26165).
      logStore: null,
      errorCode: "issue_dependencies_blocked",
      // BLO-22436 (Ally follow-up): model the gate's actual write (see note above).
      issueCommentStatus: "not_applicable",
    });
    // Older: a genuine zero-token infra-failure streak.
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: new Date(now.getTime() - 4 * 60_000),
      status: "failed",
      livenessState: "failed",
      usageJson: null,
      errorCode: "job_failed",
    });

    const service = productivityReviewService(db);
    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews[0]?.description).toContain("Primary trigger: `runtime_failure_streak`");
    expect(reviews[0]?.description).toContain("Runtime-failure streak (terminal, never-executed runs): 10");
    expect(reviews[0]?.description).toContain("No-comment streak (terminal, turn-executing runs): 0");
    // 13 non-executing runs, and no single errorCode holds a majority is false
    // here — job_failed is 10 of 13, a strict majority — so it is named. Only
    // the 3 dependency-gate cancellations are also never-invoked; the 10
    // genuine infra failures are not (BLO-22436 Ally follow-up).
    expect(reviews[0]?.description).toContain(
      "Non-executing runs in sample window (excluded from streaks above): 13 (3 already counted above as never-invoked, 10 additional; dominant errorCode: `job_failed`, 10 of 13)",
    );
  });

  // BLO-22436 (review follow-up): with an even split, naming a "dominant"
  // errorCode would be decided by run ordering and read as a definite diagnosis
  // of the window. Report that there isn't one instead.
  it("declines to name a dominant errorCode when no code holds a strict majority (BLO-22436)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 5,
      now,
      status: "cancelled",
      livenessState: null,
      usageJson: null,
      // The gate cancels a still-`queued` run, so `executeRun` never opened a
      // log store for it — `logStore`/`logRef` are null in production, same as
      // a pre-adapter setup failure. Stated explicitly because the helper now
      // defaults `logStore` to a run that executed (BLO-26165).
      logStore: null,
      errorCode: "issue_dependencies_blocked",
      // BLO-22436 (Ally follow-up): model the gate's actual write (see note above).
      issueCommentStatus: "not_applicable",
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 5,
      now: new Date(now.getTime() - 6 * 60_000),
      status: "failed",
      livenessState: "failed",
      usageJson: null,
      errorCode: "job_failed",
    });

    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.description).toContain(
      "Non-executing runs in sample window (excluded from streaks above): 10 (5 already counted above as never-invoked, 5 additional; no single dominant errorCode)",
    );
  });

  // BLO-22436 (review follow-up): the generation exemption must not leak into
  // `isProductivityReviewContinuationHoldActive`, which maps a `null` evidence
  // return to `held: false`. Gating inside `collectEvidence` would mean adding a
  // blocker to an issue under an active soft-stop hold silently released the
  // hold — converting a clean hold into dispatch/cancel churn, dropping the
  // `issue.productivity_review_continuation_held` activity signal, and leaving a
  // real hole for interaction wakes, which the dependency dispatch gate lets
  // through. The intended behaviour is that the hold is unaffected by blockers.
  it("keeps an open soft-stop continuation hold active after its source becomes dependency-blocked (BLO-22436)", async () => {
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
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);

    const heldBefore = await service.isProductivityReviewContinuationHoldActive({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      agentId: seeded.coderId,
      now,
    });
    expect(heldBefore.held).toBe(true);

    await addBlocker({
      companyId: seeded.companyId,
      issuePrefix: seeded.issuePrefix,
      blockedIssueId: seeded.issueId,
    });

    const heldAfter = await service.isProductivityReviewContinuationHoldActive({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      agentId: seeded.coderId,
      now,
    });
    expect(heldAfter.held).toBe(true);
    if (!heldAfter.held) return;
    expect(heldAfter.trigger).toBe("no_comment_streak");
  });

  // BLO-22436 (review follow-up): generation skipping blocked sources is only
  // half the fix. `createOrUpdateReview` is the only path that refreshes an open
  // review, so a review minted *before* the blocker was added would be stranded
  // open forever — never refreshed, never closed. That is exactly the loop this
  // ticket closes: the documented remedy for a flagged platform fault is to
  // model it as a `blockedBy` edge, so the remedy would otherwise freeze a
  // review pointing at an assignee who provably cannot act on it.
  it("closes an open no-comment review once its source issue becomes dependency-blocked (BLO-22436)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
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
      // Deliberately the pre-BLO-22436-follow-up shape, with no `firedTriggers`:
      // this pins the legacy fallback in `isDependencyBlockedClosableRecord`.
      // Rows written before the set existed must keep closing, or an already-open
      // legacy review on a now-blocked source is stranded open forever — nothing
      // else revisits it. The equivalent new-shape row is covered by the
      // `firedTriggers: ["no_comment_streak"]` case below.
      details: { trigger: "no_comment_streak", sourceIssueId: seeded.issueId },
    });
    await addBlocker({
      companyId: seeded.companyId,
      issuePrefix: seeded.issuePrefix,
      blockedIssueId: seeded.issueId,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.closedDependencyBlockedReviews).toBe(1);
    expect(result.closedTerminalSourceReviews).toBe(0);
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
      suppressedBy: "dependency_blocked",
      sourceIssueId: seeded.issueId,
      unresolvedBlockerCount: 1,
    });
  });

  // BLO-22436 (review follow-up): the close is scoped to the triggers the
  // dependency gate causes. `high_churn` is a record of runs that DID execute
  // and DID burn cost — a blocker added afterwards does not make that untrue,
  // and closing on it would let a flagged agent retire its own
  // cost-accountability artifact just by adding a `blockedBy` edge. Fails closed.
  it("does not close an open high-churn review when its source becomes dependency-blocked (BLO-22436)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
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
      details: { trigger: "high_churn", sourceIssueId: seeded.issueId },
    });
    await addBlocker({
      companyId: seeded.companyId,
      issuePrefix: seeded.issuePrefix,
      blockedIssueId: seeded.issueId,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.closedDependencyBlockedReviews).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.status).toBe("todo");
  });

  // BLO-22436 (Ally follow-up on 37c1bd65): the positive half of the set
  // predicate. Without this, a regression that made
  // `isDependencyBlockedClosableTriggerSet` return false unconditionally would
  // pass every other test here — the legacy row above closes through the
  // single-trigger fallback, and the co-fired row below is expected not to
  // close at all.
  it("closes an open review whose persisted fired set is entirely dependency-closable (BLO-22436)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
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
        trigger: "no_comment_streak",
        firedTriggers: ["no_comment_streak", "long_active_duration"],
        sourceIssueId: seeded.issueId,
      },
    });
    await addBlocker({
      companyId: seeded.companyId,
      issuePrefix: seeded.issuePrefix,
      blockedIssueId: seeded.issueId,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.closedDependencyBlockedReviews).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.status).toBe("done");
  });

  // BLO-22436 (Ally follow-up on 37c1bd65): the close path has the same
  // primary-vs-set hazard as the generation gate, and fixing only generation
  // would have been defeated here — a co-fired review now survives generation
  // and is then persisted with `trigger: "no_comment_streak"`, which the old
  // single-trigger close predicate would have retired on the very next pass.
  // The fired set is persisted alongside the primary precisely so this arm can
  // ask the same question.
  it("does not close an open review whose fired set includes high churn, even though its primary is closable (BLO-22436)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
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
        trigger: "no_comment_streak",
        firedTriggers: ["no_comment_streak", "high_churn"],
        sourceIssueId: seeded.issueId,
      },
    });
    await addBlocker({
      companyId: seeded.companyId,
      issuePrefix: seeded.issuePrefix,
      blockedIssueId: seeded.issueId,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.closedDependencyBlockedReviews).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.status).toBe("todo");
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

    it("regenerates the Manager Decision block when a no_comment_streak review flips to runtime_failure_streak", async () => {
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
      expect(review?.description).toContain("Primary trigger: `no_comment_streak`");
      expect(review?.description).toContain("Request decomposition");

      const refreshAt = new Date(now.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS);
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now: refreshAt,
        status: "failed",
        livenessState: "failed",
        usageJson: { inputTokens: 0, outputTokens: 0 },
      });

      const refresh = await service.reconcileProductivityReviews({ now: refreshAt, companyId: seeded.companyId });
      expect(refresh.updated).toBe(1);

      const [refreshedReview] = await listProductivityReviews(seeded.companyId);
      expect(refreshedReview?.id).toBe(review!.id);
      expect(refreshedReview?.description).toContain("Primary trigger: `runtime_failure_streak`");
      expect(refreshedReview?.description).toContain("do not decompose, block, or cancel");
      expect(refreshedReview?.description).not.toContain("Request decomposition");
    });

    it("regenerates the Manager Decision block when a runtime_failure_streak review flips to no_comment_streak", async () => {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue();
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now,
        status: "failed",
        livenessState: "failed",
        usageJson: { inputTokens: 0, outputTokens: 0 },
      });

      const service = productivityReviewService(db);
      await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
      const [review] = await listProductivityReviews(seeded.companyId);
      expect(review?.description).toContain("Primary trigger: `runtime_failure_streak`");
      expect(review?.description).toContain("do not decompose, block, or cancel");

      const refreshAt = new Date(now.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS);
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now: refreshAt,
      });

      const refresh = await service.reconcileProductivityReviews({ now: refreshAt, companyId: seeded.companyId });
      expect(refresh.updated).toBe(1);

      const [refreshedReview] = await listProductivityReviews(seeded.companyId);
      expect(refreshedReview?.id).toBe(review!.id);
      expect(refreshedReview?.description).toContain("Primary trigger: `no_comment_streak`");
      expect(refreshedReview?.description).toContain("Request decomposition");
      expect(refreshedReview?.description).not.toContain("do not decompose, block, or cancel");
    });

    it("does not rewrite the description when the refresh observes the same trigger", async () => {
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
      const originalDescription = review!.description;

      const refreshAt = new Date(now.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS);
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now: refreshAt,
      });

      const refresh = await service.reconcileProductivityReviews({ now: refreshAt, companyId: seeded.companyId });
      expect(refresh.updated).toBe(1);

      const [refreshedReview] = await listProductivityReviews(seeded.companyId);
      expect(refreshedReview?.description).toBe(originalDescription);
    });

    it("still regenerates a stale description after the refresh-comment cap is reached, without posting another comment", async () => {
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

      // Exhaust the DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS cap (3)
      // with unchanged-trigger refreshes, exactly like the existing
      // "caps refresh comments" coverage above.
      let cursor = now;
      for (let i = 0; i < DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS; i += 1) {
        cursor = new Date(cursor.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS);
        await insertRuns({
          companyId: seeded.companyId,
          agentId: seeded.coderId,
          issueId: seeded.issueId,
          count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
          now: cursor,
        });
        await service.reconcileProductivityReviews({ now: cursor, companyId: seeded.companyId });
      }
      expect(await listRefreshComments(review!.id)).toHaveLength(DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS);

      // The cap is now hit. A further refresh that only repeats the same
      // trigger should stay throttled...
      const stillNoOpAt = new Date(cursor.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS);
      const noOpRefresh = await service.reconcileProductivityReviews({
        now: stillNoOpAt,
        companyId: seeded.companyId,
      });
      expect(noOpRefresh.updated).toBe(0);
      expect(noOpRefresh.existing).toBe(1);

      // ...but a trigger flip must still correct the Manager Decision block —
      // the comment cap bounds comment churn, not correctness of the guidance.
      const flipAt = new Date(stillNoOpAt.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS);
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now: flipAt,
        status: "failed",
        livenessState: "failed",
        usageJson: { inputTokens: 0, outputTokens: 0 },
      });
      const flipRefresh = await service.reconcileProductivityReviews({ now: flipAt, companyId: seeded.companyId });
      expect(flipRefresh.updated).toBe(1);

      const [afterFlip] = await listProductivityReviews(seeded.companyId);
      expect(afterFlip?.description).toContain("Primary trigger: `runtime_failure_streak`");
      expect(afterFlip?.description).toContain("do not decompose, block, or cancel");
      // No new comment: the cap still bounds comment churn.
      expect(await listRefreshComments(review!.id)).toHaveLength(DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS);
    });

    it("preserves a description edited concurrently with a trigger-flip refresh instead of clobbering it", async () => {
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
      expect(review?.description).toContain("Primary trigger: `no_comment_streak`");

      const refreshAt = new Date(now.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS);
      await insertRuns({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
        now: refreshAt,
        status: "failed",
        livenessState: "failed",
        usageJson: { inputTokens: 0, outputTokens: 0 },
      });

      const concurrentlyEditedDescription = `${review!.description}\n\nManager note: escalating directly, do not overwrite.`;

      // Simulate a human editing the review issue's description directly
      // (e.g. via the issues API) in the window between this refresh's outer
      // read of `existing` and the transaction's guarded UPDATE. The
      // advisory lock only serializes this refresh path against itself; it
      // says nothing about a plain issue edit landing concurrently.
      const originalTransaction = db.transaction.bind(db);
      const transactionSpy = vi.spyOn(db, "transaction").mockImplementation(
        (async (...args: Parameters<typeof db.transaction>) => {
          await db
            .update(issues)
            .set({ description: concurrentlyEditedDescription })
            .where(eq(issues.id, review!.id));
          return originalTransaction(...args);
        }) as typeof db.transaction,
      );

      try {
        const refresh = await service.reconcileProductivityReviews({ now: refreshAt, companyId: seeded.companyId });
        // The refresh comment still gets appended — only the description
        // overwrite lost the race.
        expect(refresh.updated).toBe(1);
      } finally {
        transactionSpy.mockRestore();
      }

      const [afterRefresh] = await listProductivityReviews(seeded.companyId);
      expect(afterRefresh?.description).toBe(concurrentlyEditedDescription);
      expect(afterRefresh?.description).not.toContain("Primary trigger: `runtime_failure_streak`");
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

  // BLO-27698 C1/C2: the assignee's live slot occupancy, and the capacity
  // verdict cell that occupancy unlocks. The four fallback verdicts on a
  // `long_active_duration` review all presuppose an agent that had a turn and
  // used it poorly; before this a reviewer had to reconstruct saturation from
  // Kubernetes and then force one of those four anyway.
  describe("assignee concurrency evidence (BLO-27698 C1/C2)", () => {
    // Seeds `running` rows for the agent on OTHER issues — the slots that
    // starve this issue are held by other work, which is exactly why the count
    // must not be issue-scoped.
    //
    // `count` rows are stamped fresh (1 min before `now`) and so occupy a slot;
    // `staleCount` rows are stamped an hour back, past RUN_STALE_SILENCE_MS
    // (15 min), and so do NOT — the dispatcher's slot gate excludes them, so
    // the report must too. Freshness is explicit here rather than incidental:
    // these rows previously carried an hour-old `startedAt` and passed only
    // because the count was unconditional.
    async function occupySlots(input: {
      companyId: string;
      agentId: string;
      now: Date;
      count: number;
      staleCount?: number;
    }) {
      const rows = [
        ...Array.from({ length: input.count }, () => input.now.getTime() - 60 * 1000),
        ...Array.from({ length: input.staleCount ?? 0 }, () => input.now.getTime() - 60 * 60 * 1000),
      ];
      if (rows.length === 0) return;
      await db.insert(heartbeatRuns).values(
        rows.map((startedAtMs) => ({
          id: randomUUID(),
          companyId: input.companyId,
          agentId: input.agentId,
          status: "running" as const,
          invocationSource: "assignment" as const,
          startedAt: new Date(startedAtMs),
          contextSnapshot: { issueId: randomUUID() },
        })),
      );
    }

    async function reviewFor(opts: {
      slots: number;
      staleSlots?: number;
      adapterType?: string;
      runtimeConfig?: Record<string, unknown>;
    }) {
      const now = new Date("2026-04-28T12:00:00.000Z");
      const seeded = await seedAssignedIssue({
        status: "in_progress",
        startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      });
      if (opts.adapterType || opts.runtimeConfig) {
        await db
          .update(agents)
          .set({
            ...(opts.adapterType ? { adapterType: opts.adapterType } : {}),
            ...(opts.runtimeConfig ? { runtimeConfig: opts.runtimeConfig } : {}),
          })
          .where(eq(agents.id, seeded.coderId));
      }
      await occupySlots({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        now,
        count: opts.slots,
        staleCount: opts.staleSlots,
      });

      await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });
      const [review] = await listProductivityReviews(seeded.companyId);
      return review;
    }

    it("states the live running-runs-to-enforced-ceiling ratio (C1)", async () => {
      // codex_local is not external-lifecycle, so the enforced ceiling is the
      // raw policy value — no BLO-15959 clamp.
      const review = await reviewFor({ slots: 2, runtimeConfig: { heartbeat: { maxConcurrentRuns: 5 } } });
      expect(review?.description).toContain(
        "- Assignee live concurrency: 2/5 running runs against the dispatcher's enforced ceiling",
      );
      // Not saturated: no capacity claim, and no capacity verdict offered.
      expect(review?.description).not.toContain("**saturated**");
    });

    it("reports the external-lifecycle clamp, not the configured value, as the ceiling (C1)", async () => {
      // BLO-15959: concurrencyEnabled defaults off, so a k8s agent configured
      // for 8 is really held to 1. Reporting 8 here would tell a reviewer the
      // agent had 7 free slots it declined to use — the exact inversion of the
      // truth. This assertion is what makes the reported ceiling load-bearing
      // rather than decorative.
      const review = await reviewFor({
        slots: 1,
        adapterType: "claude_k8s",
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 8 } },
      });
      expect(review?.description).toContain("- Assignee live concurrency: 1/1 running runs");
      expect(review?.description).toContain("held to 1 because external-lifecycle `concurrencyEnabled` is off");
      expect(review?.description).toContain("**saturated**");
    });

    it("offers the capacity/platform verdict when the assignee is saturated (C2)", async () => {
      const review = await reviewFor({ slots: 3, runtimeConfig: { heartbeat: { maxConcurrentRuns: 3 } } });
      expect(review?.description).toContain("Route to platform/SRE as a capacity/dispatch constraint");
      expect(review?.description).toContain("all 3 of the assignee's run slots occupied");
      // The cell must precede the four assignee-directed verdicts, which are
      // the wrong instruction for an agent that never got a turn.
      expect(review!.description!.indexOf("Route to platform/SRE as a capacity/dispatch constraint"))
        .toBeLessThan(review!.description!.indexOf("- Request decomposition"));
      // Ally finding 2 on #1856: `assigneeConcurrency` is ONE sample taken at
      // `now`, so it cannot carry an episode-wide claim. The cell must say what
      // it measured and ask the reviewer to confirm, not instruct them not to
      // record under-performance across hours it never observed.
      expect(review?.description).toContain("occupied as of this evidence snapshot");
      expect(review?.description).toContain("not established across the whole episode");
      expect(review?.description).not.toContain("do not record this as assignee under-performance");
    });

    it("does not emit the categorical exoneration on a small, non-dominant no-executable-turn span (C2)", async () => {
      // Ally finding 1 on #1856: the `noExecutableTurn` arm fired on `> 0`, so
      // ~30s of queue time inside a 7h episode emitted the full "the assignee
      // was not given an executable turn … do not record this as assignee
      // under-performance". The five original C2 tests all seeded `slots` only,
      // leaving `noExecutableTurnMs` incidentally 0 — this arm was never driven
      // by any of them, which is why the defect survived them.
      //
      // Free slots deliberately: this isolates the turn-time arm. 4m of a 7h
      // episode is ~1%, far below NO_EXECUTABLE_TURN_DOMINANT_SHARE.
      const now = new Date("2026-04-28T12:00:00.000Z");
      const episodeStart = new Date(now.getTime() - 7 * 60 * 60 * 1000);
      const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
      await insertNeverDispatchedRun({
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        issueId: seeded.issueId,
        createdAt: new Date(now.getTime() - 34 * 60 * 1000),
        finishedAt: new Date(now.getTime() - 30 * 60 * 1000),
      });

      await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
      });
      const [review] = await listProductivityReviews(seeded.companyId);

      expect(review?.description).toContain("Primary trigger: `long_active_duration`");
      // Still OFFERED — a real capacity block the reviewer should see. Only the
      // wording is graded; withholding the cell would be the other failure.
      expect(review?.description).toContain("Route to platform/SRE as a capacity/dispatch constraint");
      expect(review?.description).toContain("PARTIAL capacity block");
      expect(review?.description).toContain("Confirm it held for the period in question before routing");
      // The categorical half must NOT appear: 4m does not exonerate 7h.
      expect(review?.description).not.toContain("was not given an executable turn");
      expect(review?.description).not.toContain("do not record this as assignee under-performance");
      // And the four assignee-directed verdicts stay on the table.
      expect(review?.description).toContain("- Request decomposition");
    });

    it("withholds the capacity verdict when the assignee had free slots (C2 negative control)", async () => {
      // The important half. An always-present capacity cell would become the
      // default verdict for every slow episode — the opposite failure to the
      // one C2 fixes, and a strictly worse one, because it excuses real
      // inactivity rather than merely failing to explain a stall.
      const review = await reviewFor({ slots: 0, runtimeConfig: { heartbeat: { maxConcurrentRuns: 4 } } });
      expect(review?.description).toContain("Primary trigger: `long_active_duration`");
      expect(review?.description).toContain("- Assignee live concurrency: 0/4 running runs");
      expect(review?.description).not.toContain("Route to platform/SRE as a capacity/dispatch constraint");
      // The four assignee-directed verdicts are still offered.
      expect(review?.description).toContain("- Request decomposition");
    });

    it("excludes stale running rows from the occupancy count (C1/C2 regression)", async () => {
      // The dispatcher's slot gate counts only NON-stale running rows
      // (BLO-12990): a row silent past RUN_STALE_SILENCE_MS does not starve new
      // work. Counting every `running` row here reported `2/2 … saturated` and
      // offered the capacity verdict while dispatch would still have admitted a
      // turn — a false capacity explanation, which is worse than none because
      // it reads as measurement and excuses inactivity that was never excused.
      // Both rows below are silent for an hour, so every effective slot is in
      // fact free.
      const review = await reviewFor({
        slots: 0,
        staleSlots: 2,
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } },
      });
      expect(review?.description).toContain("- Assignee live concurrency: 0/2 running runs");
      expect(review?.description).not.toContain("**saturated**");
      expect(review?.description).not.toContain("Route to platform/SRE as a capacity/dispatch constraint");
      expect(review?.description).toContain("- Request decomposition");
    });
  });

  // BLO-19848: `long_active_duration` measured raw wall-clock from
  // issues.started_at to now with no reference to whether anything was actually
  // executing, so an issue pinned by a non-live executionRunId kept accruing
  // "active" time after its work finished. The assignee could not even
  // transition the issue out (the same wedge returns 409 Issue run ownership
  // conflict), so the review fired on work that was already merged and the
  // assignee had no way to stop it. BLO-18307 reported a "1d 7h active episode"
  // behind a `scheduled_retry` holder; BLO-12565 and BLO-12696 match.
  async function pinExecutionRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status: "scheduled_retry" | "queued" | "running" | "succeeded";
    lockedAt: Date;
    lastOutputAt?: Date | null;
    lastUsefulActionAt?: Date | null;
    finishedAt?: Date | null;
    scheduledRetryAt?: Date | null;
    scheduledRetryAttempt?: number;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      invocationSource: "assignment",
      startedAt: null,
      lastOutputAt: input.lastOutputAt ?? null,
      lastUsefulActionAt: input.lastUsefulActionAt ?? null,
      finishedAt: input.finishedAt ?? null,
      scheduledRetryAt: input.scheduledRetryAt ?? null,
      scheduledRetryAttempt: input.scheduledRetryAttempt ?? 0,
      contextSnapshot: { issueId: input.issueId, taskId: input.issueId },
    });
    await db
      .update(issues)
      .set({ executionRunId: runId, checkoutRunId: runId, executionLockedAt: input.lockedAt })
      .where(eq(issues.id, input.issueId));
    return { runId };
  }

  it("does not fire long_active_duration on an episode pinned by a scheduled_retry run (BLO-19848)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const episodeStart = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
    await pinExecutionRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      status: "scheduled_retry",
      // Parked from the moment the episode began: nothing has executed since,
      // so zero of the 7h is attributable to a live run.
      lockedAt: episodeStart,
    });
    const service = productivityReviewService(db);

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("does not fire long_active_duration on an episode pinned by a terminal run (BLO-19848)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const episodeStart = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
    await pinExecutionRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      status: "succeeded",
      lockedAt: episodeStart,
      // Finished 30m into the episode; the remaining 6.5h is not active work.
      finishedAt: new Date(episodeStart.getTime() + 30 * 60 * 1000),
    });
    const service = productivityReviewService(db);

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(0);
  });

  it("still fires long_active_duration while the execution holder is live (BLO-19848)", async () => {
    // The guard against over-correcting: a genuinely long *live* episode must
    // still be reviewable. Only non-live hold time is excluded.
    const now = new Date("2026-04-28T12:00:00.000Z");
    const episodeStart = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
    await pinExecutionRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      status: "running",
      lockedAt: episodeStart,
      // Produced output 10 minutes ago — well inside the silence bound.
      lastOutputAt: new Date(now.getTime() - 10 * 60 * 1000),
    });
    const service = productivityReviewService(db);

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
  });

  // BLO-30303: candidate-selection starvation. The scan reads
  // `LIMIT MAX_CANDIDATE_ISSUES` and nothing in the review pipeline writes back
  // to a scanned *source* row, so under the old `asc(updatedAt)` ordering the
  // same oldest-N rows were re-selected on every pass forever. Once the
  // eligible population passed the cap, an issue outside that window could
  // never receive a review no matter how many passes ran — which is why
  // fleet-wide emission was a hard zero from 2026-08-19 to 2026-09-12.
  //
  // The assertion that matters is rotation across passes, not reachability on
  // any single pass. A watermark still sorts the target last on pass 1 (every
  // row starts NULL, so ties fall through to the old `updatedAt` order); what
  // it guarantees is that pass 2 reaches it. Pre-fix this test is red at *any*
  // number of passes, which is the distinction a `desc(updatedAt)` flip would
  // fail to make.
  it("reaches a recently-updated stalled issue that sorts outside one scan window (BLO-30303)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const episodeStart = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    // seedAssignedIssue stamps updatedAt = 2026-04-28T10:00:00Z, so every decoy
    // below sorts ahead of the target under `asc(updatedAt)`.
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
    await pinExecutionRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      status: "running",
      lockedAt: episodeStart,
      lastOutputAt: new Date(now.getTime() - 10 * 60 * 1000),
    });

    // Fill one whole scan window with eligible-but-uninteresting rows. They
    // must be genuinely eligible (agent-assigned, non-terminal, not a review)
    // to occupy the window; they just never fire a trigger.
    const decoyCount = 250;
    const decoyUpdatedAt = new Date("2026-04-01T00:00:00.000Z");
    await db.insert(issues).values(
      Array.from({ length: decoyCount }, (_, i) => ({
        id: randomUUID(),
        companyId: seeded.companyId,
        title: `Decoy ${i}`,
        status: "in_progress" as const,
        priority: "medium" as const,
        assigneeAgentId: seeded.coderId,
        originKind: "manual",
        issueNumber: 1000 + i,
        identifier: `${seeded.issuePrefix}-${1000 + i}`,
        // Recent episode start: nothing for long_active_duration to fire on.
        startedAt: new Date(now.getTime() - 60 * 1000),
        createdAt: decoyUpdatedAt,
        updatedAt: decoyUpdatedAt,
      })),
    );

    const service = productivityReviewService(db);

    const first = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    expect(first.scanned).toBe(decoyCount);

    const second = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    // Pre-fix both passes scan the identical oldest-250 decoys and this is 0.
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews.map((review) => review.originId)).toContain(seeded.issueId);
    expect(second.scanned).toBeGreaterThan(0);
  }, 120_000);

  // BLO-30303 Ally review follow-up: the first cut ordered `NULLS FIRST`, which
  // is an *absolute* priority class — never-scanned rows outrank every scanned
  // row no matter how long the scanned one has waited. Under a sustained influx
  // of >= MAX_CANDIDATE_ISSUES new eligible rows per pass, the NULL cohort
  // consumes the entire window on every pass and an already-scanned row is
  // never revisited.
  //
  // That victim is the one that matters: a row is scanned while it is still
  // healthy, and only becomes interesting once it *later* goes quiet. So the
  // rows this detector exists to catch are exactly the rows NULLS FIRST can
  // permanently preempt. Coalescing to `createdAt` makes the key a strict FIFO
  // and closes it.
  it("re-reaches an already-scanned issue under a sustained influx of never-scanned rows (BLO-30303)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const episodeStart = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
    await pinExecutionRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      status: "running",
      lockedAt: episodeStart,
      lastOutputAt: new Date(now.getTime() - 10 * 60 * 1000),
    });

    // The victim is a row already visited on an earlier pass — the state every
    // healthy issue is in before it goes quiet. It has waited longer than any
    // row in the influx below, so a fair scan must reach it first.
    await db
      .update(issues)
      .set({ productivityScannedAt: new Date("2026-04-20T00:00:00.000Z") })
      .where(eq(issues.id, seeded.issueId));

    // One full scan window of genuinely-new eligible rows per pass. They are
    // *newer* than the victim's watermark, so under a FIFO key they queue
    // behind it; under NULLS FIRST they preempt it outright.
    const influxSize = 250;
    const insertInflux = async (round: number) => {
      await db.insert(issues).values(
        Array.from({ length: influxSize }, (_, i) => {
          // Widely-spaced blocks: a review issue created by the previous pass
          // takes `max(issueNumber) + 1`, which would collide with a
          // contiguous next block.
          const n = 10_000 + round * 1_000 + i;
          return {
            id: randomUUID(),
            companyId: seeded.companyId,
            title: `Influx ${round}-${i}`,
            status: "in_progress" as const,
            priority: "medium" as const,
            assigneeAgentId: seeded.coderId,
            originKind: "manual",
            issueNumber: n,
            identifier: `${seeded.issuePrefix}-${n}`,
            // Recent episode start: nothing for long_active_duration to fire on.
            startedAt: new Date(now.getTime() - 60 * 1000),
            createdAt: new Date(now.getTime() - 60 * 60 * 1000),
            updatedAt: new Date(now.getTime() - 60 * 60 * 1000),
          };
        }),
      );
    };

    const service = productivityReviewService(db);
    for (const round of [0, 1]) {
      await insertInflux(round);
      await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    }

    // Pre-fix the NULL cohort fills the window on both passes and this is 0.
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews.map((review) => review.originId)).toContain(seeded.issueId);
  }, 120_000);

  // BLO-19848 review follow-up: the tail clamp alone regressed the moment a
  // parked holder resumed. Once the run is `running` again it is genuinely
  // live, so the clamp releases — and because elapsed was still measured from
  // issues.started_at, the entire parked interval was re-attributed to active
  // work. A long park plus a short run therefore still tripped the trigger,
  // which is the same false positive by another route.
  it("excludes a parked interval after the holder is promoted back to running (BLO-19848)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const episodeStart = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
    await pinExecutionRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      status: "running",
      lockedAt: episodeStart,
      // Parked for 6h50m, promoted 10m ago. promoteDueScheduledRetry writes only
      // status/error/updatedAt, so scheduledRetryAt survives promotion as the
      // record of when the park ended.
      scheduledRetryAt: new Date(now.getTime() - 10 * 60 * 1000),
      scheduledRetryAttempt: 1,
      // Live right now — this is what releases the tail clamp.
      lastOutputAt: new Date(now.getTime() - 60 * 1000),
    });
    const service = productivityReviewService(db);

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    // Only the 10m live segment is attributable, well under the 6h threshold.
    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("still fires long_active_duration on a long live segment that followed a park (BLO-19848)", async () => {
    // The over-correction guard for the case above: excluding the park must not
    // excuse a live segment that is itself long enough to review.
    const now = new Date("2026-04-28T12:00:00.000Z");
    const episodeStart = new Date(now.getTime() - 14 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
    await pinExecutionRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      status: "running",
      lockedAt: episodeStart,
      // Parked for the first 7h, then running for the last 7h.
      scheduledRetryAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      scheduledRetryAttempt: 1,
      lastOutputAt: new Date(now.getTime() - 60 * 1000),
    });
    const service = productivityReviewService(db);

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
    // The excluded park is reported rather than silently dropped.
    expect(review?.description).toContain("Excluded as non-live execution hold");
  });

  it("excludes only the silent tail when a running holder goes quiet mid-episode (BLO-19848)", async () => {    const now = new Date("2026-04-28T12:00:00.000Z");
    const episodeStart = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
    await pinExecutionRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      status: "running",
      lockedAt: episodeStart,
      // Last output 4h ago — past the 2h silence bound, so the episode is
      // truncated at the silence deadline: 5h attributable, under the 6h threshold.
      lastOutputAt: new Date(now.getTime() - 4 * 60 * 60 * 1000),
    });
    const service = productivityReviewService(db);

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(0);
  });


  // BLO-25722: both BLO-19848 helpers read a single row — the issue's current
  // `executionRunId` holder — so an episode made of a *chain* of runs kept
  // silently re-absorbing every earlier row's queue wait. Once the last row
  // reached `running` the tail clamp released, elapsed ran uncapped from
  // issues.started_at, and `monitorGatingBreakdown` reported the lot as
  // unattended. BLO-23547's review claimed "13h 23m unattended" for BLO-21395
  // when 710 of those 802 minutes (88.5%) were queue->start latency across three
  // sequential runs, each waiting hours for a slot while its agent sat pinned at
  // maxConcurrentRuns (BLO-23699). Timings below are that episode's real chain.
  async function insertRunChain(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    runs: Array<{
      createdAt: Date;
      startedAt: Date | null;
      finishedAt?: Date | null;
      status: string;
      lastOutputAt?: Date | null;
    }>;
    lockedAt: Date;
  }) {
    const rows = input.runs.map((run) => ({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      status: run.status,
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
      lastOutputAt: run.lastOutputAt ?? null,
      contextSnapshot: { issueId: input.issueId, taskId: input.issueId },
      // Every run in this chain executed model turns; only their *queue* time is
      // at issue, so none of them may be filtered as never-executed (BLO-21769).
      livenessState: "advanced",
      usageJson: { input_tokens: 1000, output_tokens: 500 },
      logBytes: 4096,
      createdAt: run.createdAt,
      updatedAt: run.createdAt,
    }));
    await db.insert(heartbeatRuns).values(rows);
    // The live run holds the lock; a merely-queued sibling never does. Callers
    // therefore pass the holder last, whatever the createdAt ordering.
    const holder = rows[rows.length - 1]!;
    await db
      .update(issues)
      .set({ executionRunId: holder.id, checkoutRunId: holder.id, executionLockedAt: input.lockedAt })
      .where(eq(issues.id, input.issueId));
    return rows;
  }

  it("does not fire on a retry chain whose flagged time was queue wait (BLO-25722)", async () => {
    // BLO-23547's chain, replayed: 232m + 301m + 178m queued across three
    // sequential runs, the third live right now.
    //
    // Passes with and without the BLO-25722 union (measured 2026-08-15): the
    // episode anchors on `max(startedAt)` = 09:44, so it spans 3h 16m and never
    // sees the earlier queue wait at all. Kept as an end-to-end guard on that
    // anchor — a regression to checkout-anchoring reads 15h 18m and fires.
    const now = new Date("2026-08-09T13:00:00.000Z");
    const episodeStart = new Date("2026-08-08T21:42:00.000Z");
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
    await insertRunChain({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      lockedAt: episodeStart,
      runs: [
        {
          createdAt: episodeStart,
          startedAt: new Date("2026-08-09T01:34:00.000Z"), // 232m queued
          finishedAt: new Date("2026-08-09T01:36:00.000Z"),
          status: "failed",
        },
        {
          createdAt: new Date("2026-08-09T01:36:00.000Z"),
          startedAt: new Date("2026-08-09T06:37:00.000Z"), // 301m queued
          finishedAt: new Date("2026-08-09T06:45:00.000Z"),
          status: "failed",
        },
        {
          createdAt: new Date("2026-08-09T06:46:00.000Z"),
          startedAt: new Date("2026-08-09T09:44:00.000Z"), // 178m queued
          status: "running",
          lastOutputAt: new Date(now.getTime() - 60 * 1000),
        },
      ],
    });
    const service = productivityReviewService(db);

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    // 3h 16m attributable from the last dispatch, under the 6h threshold.
    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("does not charge a retry chain's queue wait to the assignee once the trigger does fire (BLO-25722)", async () => {
    // Same chain, but the live segment is long enough that the trigger still
    // fires, so the evidence block is generated and the elapsed figure is
    // readable.
    //
    // This test originally asserted `Excluded as non-live execution hold:
    // 11h 51m` (232+301+178) on the theory that the chain's queue wait reaches
    // the numerator and has to be subtracted back out by the BLO-25722 union.
    // Measured 2026-08-15, that theory is wrong: the episode anchors on
    // `mostRecentDispatchAt` = `max(startedAt)` (BLO-19604), so it opens at the
    // *last* dispatch (09:44) and every earlier queue wait is outside the
    // window before any exclusion runs. Elapsed is 9h 16m — 11m *stricter* than
    // the 9h 27m the union model predicted, because the anchor also drops the
    // two earlier runs' live minutes. Control: this file's four BLO-25722 cases
    // behave identically with and without the union (2 pass / 2 fail either
    // way), which is what proved the pre-dispatch half of the fix is inert.
    //
    // So the property worth pinning here is the outcome, not the mechanism: the
    // 21h 18m pre-BLO-19604 reading must never come back. The union's live
    // surface is post-dispatch queue wait only — pinned by the population-3
    // replay below, which does fail without it.
    const now = new Date("2026-08-09T19:00:00.000Z");
    const episodeStart = new Date("2026-08-08T21:42:00.000Z");
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
    await insertRunChain({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      lockedAt: episodeStart,
      runs: [
        {
          createdAt: episodeStart,
          startedAt: new Date("2026-08-09T01:34:00.000Z"),
          finishedAt: new Date("2026-08-09T01:36:00.000Z"),
          status: "failed",
        },
        {
          createdAt: new Date("2026-08-09T01:36:00.000Z"),
          startedAt: new Date("2026-08-09T06:37:00.000Z"),
          finishedAt: new Date("2026-08-09T06:45:00.000Z"),
          status: "failed",
        },
        {
          createdAt: new Date("2026-08-09T06:46:00.000Z"),
          startedAt: new Date("2026-08-09T09:44:00.000Z"),
          status: "running",
          lastOutputAt: new Date(now.getTime() - 60 * 1000),
        },
      ],
    });
    const service = productivityReviewService(db);

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    // BLO-27698 B3b: this fixture IS the runaway case — a `running` run signalling
    // a minute ago, executing unbroken since the last dispatch — so the relocation
    // lands here, exactly as the B1 note below predicted. The elapsed-accounting
    // guard this test exists for is unaffected: the report still renders, and the
    // 21h 18m figure is still asserted absent from both buckets.
    expect(review?.description).toContain("Primary trigger: `runaway_execution`");
    // Anchored at the last dispatch (09:44), not at checkout (21:42).
    // BLO-27698 B1: the anchored span now reads as `executing` rather than
    // `unattended` — the run is `running` and emitting, so it covers the whole
    // episode. Only the bucket label moved; the quantity under test is the same,
    // the review still fires (`created: 1` above, because the suppression gate
    // compares `unattendedMs + executingMs`), and the 21h 18m guard below is
    // asserted against BOTH buckets so it cannot be evaded through the new one.
    // A 9h 16m unbroken executing span is the runaway case B3b must relocate to a
    // named runtime/cost trigger before B3 narrows the gate to `unattendedMs`.
    expect(review?.description).toContain("9h 16m executing");
    // The regression this exists to catch: charging the whole 21h 18m
    // checkout-to-now span, queue wait included, to the assignee.
    expect(review?.description).not.toContain("21h 18m unattended");
    expect(review?.description).not.toContain("21h 18m executing");
  });

  it("does not exclude a queue wait that overlapped another run's live work (BLO-25722)", async () => {
    // The over-correction guard, and the one BLO-25722 case that still binds. A
    // run sitting `queued` while a *different* run works the same issue is not
    // idle time; unioning its wait unguarded would withhold real working time.
    // The queued row here waits 6h 50m of a 7h episode, so dropping the overlap
    // guard collapses elapsed to 10m and `created` falls to 0.
    //
    // It previously also asserted `Excluded as non-live execution hold: 10m` for
    // the live run's own 11:50→12:00 wait. That is unreachable: the episode
    // anchors on `max(startedAt)` = 12:00, so those 10m sit outside the window
    // and are never in the numerator to exclude. Asserting the absence of the
    // line instead — an exclusion appearing here would mean the anchor moved.
    const now = new Date("2026-08-09T19:00:00.000Z");
    const episodeStart = new Date("2026-08-09T11:50:00.000Z");
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
    await insertRunChain({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      lockedAt: episodeStart,
      runs: [
        {
          // Enqueued while the run below is live, and still waiting for a slot.
          createdAt: new Date("2026-08-09T12:10:00.000Z"),
          startedAt: null,
          status: "queued",
        },
        {
          createdAt: new Date("2026-08-09T11:50:00.000Z"),
          startedAt: new Date("2026-08-09T12:00:00.000Z"), // 10m queued
          status: "running",
          lastOutputAt: new Date(now.getTime() - 60 * 1000),
        },
      ],
    });
    const service = productivityReviewService(db);

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    // 430m episode, anchored at 12:00. The 6h 50m overlapping queue wait stays
    // in: a live run was working the issue throughout.
    //
    // BLO-27698 B1: "stays in" is still the assertion — the span is not excused
    // from the episode — but it now reads as `executing`, because the run
    // covering it is `running` and emitting. `created: 1` is unchanged: the
    // suppression gate compares `unattendedMs + executingMs`, so B1 moves the
    // label without moving the verdict. B3 is what narrows that gate, and B3b is
    // where this shape has to resurface as a runtime/cost trigger.
    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("7h 0m executing");
    expect(review?.description).not.toContain("Excluded as non-live execution hold");
  });

  it("excludes queue wait from a retry chain longer than the streak sample cap (BLO-25722)", async () => {
    // Review follow-up: duration accounting originally reused `latestRuns`,
    // which is capped at MAX_RUNS_FOR_STREAK (100) for streak walking. A chain
    // longer than the cap silently dropped its OLDEST queue-wait intervals —
    // reviving the false positive first on the worst-wedged issues, the ones
    // with the most runs. Duration accounting is now scoped by the episode
    // window instead of by run count.
    //
    // 140 runs x (20m queued + 2m live). Correct attributable time is the 280m
    // of live work, well under the 6h threshold. Capped at the newest 100, the
    // 40 oldest runs' 800m of queue wait reverts to "elapsed" and the episode
    // reads 18h — firing the exact review this change exists to prevent.
    const episodeStart = new Date("2026-08-01T00:00:00.000Z");
    const runCount = 140;
    const cycleMs = 22 * 60 * 1000;
    const now = new Date(episodeStart.getTime() + runCount * cycleMs);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
    const runs = Array.from({ length: runCount }, (_, i) => {
      const createdAt = new Date(episodeStart.getTime() + i * cycleMs);
      const startedAt = new Date(createdAt.getTime() + 20 * 60 * 1000);
      const isLast = i === runCount - 1;
      return isLast
        ? {
            createdAt,
            startedAt,
            status: "running",
            lastOutputAt: new Date(now.getTime() - 60 * 1000),
          }
        : {
            createdAt,
            startedAt,
            finishedAt: new Date(startedAt.getTime() + 2 * 60 * 1000),
            status: "failed",
          };
    });
    const inserted = await insertRunChain({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      lockedAt: episodeStart,
      runs,
    });
    // Every run comments, so `no_comment_streak` cannot fire on a chain this
    // long and confound what is under test here: `long_active_duration`'s
    // duration accounting alone.
    await db.insert(issueComments).values(
      inserted.map((run, index) => ({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        authorAgentId: seeded.coderId,
        createdByRunId: run.id,
        body: `Progress update ${index}`,
        createdAt: run.createdAt as Date,
        updatedAt: run.createdAt as Date,
      })),
    );
    const service = productivityReviewService(db);

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("keeps long_active_duration monotonic just past the running silence boundary (BLO-19848)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const episodeStart = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
    await pinExecutionRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      status: "running",
      lockedAt: episodeStart,
      // One minute past the 2h silence boundary still leaves nearly the full
      // seven-hour episode attributable. The clamp must not jump backward to
      // the raw last signal and erase the whole grace period.
      lastOutputAt: new Date(now.getTime() - 2 * 60 * 60 * 1000 - 60_000),
    });
    const service = productivityReviewService(db);

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
  });

  it("uses the newest execution signal instead of field priority for running holders (BLO-19848)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const episodeStart = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
    await pinExecutionRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      status: "running",
      lockedAt: episodeStart,
      lastUsefulActionAt: new Date(now.getTime() - 4 * 60 * 60 * 1000),
      lastOutputAt: new Date(now.getTime() - 10 * 60 * 1000),
    });
    const service = productivityReviewService(db);

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
  });

  // BLO-23248/BLO-22331: a capacity-class `scheduled_retry` (fleet
  // ccrotate/penstock model-provider exhaustion) clears `issue.executionRunId`
  // to null the moment it is scheduled (`scheduleBoundedRetryForRun` in
  // heartbeat.ts), so the BLO-19848 `nonLiveExecutionHoldSince` clamp above
  // — which only sees a hold via `issue.executionRunId` — never engages for
  // this state and the whole park counts as unattended. These fixtures
  // reproduce that exact state (heartbeat run present and issue-scoped via
  // `contextSnapshot`, but `issue.executionRunId` left null) rather than
  // using `pinExecutionRun`, which sets the pointer this bug is about the
  // absence of.
  async function insertCapacityScheduledRetryRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    createdAt: Date;
    scheduledRetryAt: Date;
    scheduledRetryReason?: string | null;
    errorCode?: string | null;
    id?: string;
  }) {
    const runId = input.id ?? randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "scheduled_retry",
      invocationSource: "automation",
      triggerDetail: "system",
      errorCode: input.errorCode ?? "rate_limit_exhausted",
      scheduledRetryAt: input.scheduledRetryAt,
      scheduledRetryAttempt: 0,
      scheduledRetryReason: input.scheduledRetryReason ?? "ccrotate_capacity",
      contextSnapshot: { issueId: input.issueId, taskId: input.issueId },
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    return { runId };
  }

  // BLO-19604/BLO-21621: a run that never reached `startedAt` — still sitting
  // `queued`, or already cancelled out from under it by the detached-queued-run
  // sweep (`queued_run_detached_from_issue`). Either way the assignee never got
  // a turn on it.
  async function insertNeverDispatchedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    createdAt: Date;
    status?: "queued" | "cancelled";
    errorCode?: string | null;
    // BLO-23624 (Ally finding 1): the sweep can cancel a queued run any time
    // after it was created — defaults to an instant cancellation, but a
    // fixture modeling a run that genuinely sat queued for a while before
    // being cancelled must pass this explicitly, since
    // `noExecutableTurnBreakdown` now caps a terminal run's contribution at
    // its own `finishedAt` rather than at the next run's `createdAt`.
    finishedAt?: Date | null;
  }) {
    const runId = randomUUID();
    const status = input.status ?? "cancelled";
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status,
      invocationSource: "automation",
      triggerDetail: "system",
      startedAt: null,
      finishedAt: status === "cancelled" ? (input.finishedAt ?? input.createdAt) : null,
      errorCode: input.errorCode ?? "queued_run_detached_from_issue",
      contextSnapshot: { issueId: input.issueId, taskId: input.issueId },
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    return { runId };
  }

  // BLO-21769/BLO-23624: a terminal run whose liveness classification came
  // back `failed` after burning zero input/output tokens — the runtime never
  // reached a model turn (e.g. `provider_throttled_no_progress`).
  async function insertZeroTokenFailureRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    createdAt: Date;
    errorCode?: string | null;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "failed",
      invocationSource: "automation",
      triggerDetail: "system",
      startedAt: input.createdAt,
      finishedAt: new Date(input.createdAt.getTime() + 1_000),
      livenessState: "failed",
      usageJson: { inputTokens: 0, outputTokens: 0 },
      errorCode: input.errorCode ?? "provider_throttled_no_progress",
      contextSnapshot: { issueId: input.issueId, taskId: input.issueId },
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    return { runId };
  }

  it("does not fire long_active_duration while a capacity-class scheduled_retry is still due in the future, even though issue.executionRunId is null (BLO-23248/BLO-22331)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const episodeStart = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
    await insertCapacityScheduledRetryRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      createdAt: episodeStart,
      scheduledRetryAt: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000),
    });
    // Sanity: reproduce the reported bug state directly — the issue's
    // execution pointer is null while a live scheduled_retry row exists for it.
    const [issueRow] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issueRow?.executionRunId).toBeNull();

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("still fires long_active_duration once an overdue capacity retry sits unpromoted, naming the no-executable-turn mix rather than the assignee (BLO-22331 no-indefinite-suppression guard, generalized by BLO-23624)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const episodeStart = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
    const { runId } = await insertCapacityScheduledRetryRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      createdAt: episodeStart,
      // Due an hour ago and never promoted/dispatched: a genuinely wedged
      // retry chain, which BLO-22331's AC requires to remain reviewable
      // rather than suppressed forever.
      scheduledRetryAt: new Date(now.getTime() - 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
    expect(review?.description).toContain("currently behind an overdue");
    expect(review?.description).toContain("fleet-capacity signal, not assignee inactivity");
    expect(review?.description).toContain(`run \`${runId}\``);
    expect(review?.description).toContain(`No-executable-turn accounting:`);
    // BLO-27698 C2 positive control for the wording split (Ally finding 1 on
    // #1856). The retry spans essentially the whole 7h episode, so the
    // no-executable-turn share clears NO_EXECUTABLE_TURN_DOMINANT_SHARE and
    // this — unlike a 4m span or a single concurrency sample — genuinely IS
    // episode-scoped evidence. Pinned here because grading the cell down to
    // "partial" everywhere would be the opposite over-correction, and nothing
    // else in the suite would catch it.
    expect(review?.description).toContain("the assignee was not given an executable turn");
    expect(review?.description).toContain("do not record this as assignee under-performance");
    expect(review?.description).not.toContain("PARTIAL capacity block");
  });

  it("surfaces the no-executable-turn bucket in evidence and does not let long_active_duration ride along when a different trigger fires (BLO-23248 AC, generalized by BLO-23624)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const episodeStart = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });
    // 10 terminal, turn-executing runs with no comments — trips
    // no_comment_streak on its own, independent of the capacity retry.
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now: episodeStart,
    });
    // The most recent run for the issue is the still-future capacity retry —
    // the chronologically-last run, so it (not the older terminal runs) drives
    // `noExecutableTurnGating`. It must be STRICTLY newer than every streak
    // run: `insertRuns` stamps its newest row at exactly `now`, so seeding
    // this at `episodeStart` too tied the head of the `desc(createdAt),
    // desc(id)` ordering, leaving the winner to be decided by which
    // `randomUUID()` sorted higher — a ~50/50 flake that passed locally and
    // failed in CI. `scheduled_retry` is in ACTIVE_RUN_STATUSES, not
    // TERMINAL_RUN_STATUSES, so moving it later keeps it out of the
    // `no_comment_streak` walk unchanged.
    await insertCapacityScheduledRetryRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      createdAt: new Date(episodeStart.getTime() + 60_000),
      scheduledRetryAt: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    // no_comment_streak fired on its own merits; long_active_duration was
    // eligible on elapsed time (7h > default 6h threshold) but suppressed.
    expect(review?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(review?.description).not.toContain("Primary trigger: `long_active_duration`");
    expect(review?.description).toContain("No-executable-turn accounting:");
    expect(review?.description).toContain("capacity park");
  });

  // BLO-23624: the worked example from the issue (BLO-23427, decomposed from
  // BLO-22887) — three distinct no-executable-turn mechanisms stacked in one
  // episode, none individually dominant enough under the old capacity-only
  // numerator (65.8% capacity share alone), but 100% dominant under the
  // widened union. Per-mechanism durations mirror the issue's own table
  // exactly: 54s zero-token throttle, 6h dispatch backlog, 11h35m capacity
  // park (current, still due). Timestamps are strictly distinct per run to
  // avoid the `desc(createdAt), desc(id)` tiebreak flake called out in the
  // issue and reproduced by #1188.
  it("does not fire long_active_duration on a mixed-mechanism episode (BLO-23427 decomposition: throttle + dispatch backlog + capacity park)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const throttleAt = new Date(now.getTime() - (54_000 + 6 * 60 * 60 * 1000 + (11 * 60 + 35) * 60 * 1000));
    const backlogAt = new Date(throttleAt.getTime() + 54_000);
    const capacityAt = new Date(backlogAt.getTime() + 6 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: throttleAt });

    await insertZeroTokenFailureRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      createdAt: throttleAt,
    });
    await insertNeverDispatchedRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      createdAt: backlogAt,
      status: "cancelled",
      // Sat genuinely queued for the full 6h — the sweep only cancelled it
      // once the capacity retry took over, not the instant it was created
      // (see finding-1 fix note on the helper).
      finishedAt: capacityAt,
    });
    await insertCapacityScheduledRetryRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      createdAt: capacityAt,
      scheduledRetryAt: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  // BLO-23624 boundary AC: a 14h43m dispatch-backlog window beside an 11h35m
  // capacity park lands at ~44% capacity share (under the old, capacity-only
  // 50% dominance test — would have fired) but ~100% no-executable-turn share
  // under the widened union — must not fire.
  it("does not fire long_active_duration at the ~44%-capacity-share boundary once dispatch backlog is folded into the same bucket (BLO-23624 boundary AC)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const backlogAt = new Date(now.getTime() - ((14 * 60 + 43) * 60 * 1000 + (11 * 60 + 35) * 60 * 1000));
    const capacityAt = new Date(backlogAt.getTime() + (14 * 60 + 43) * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: backlogAt });

    await insertNeverDispatchedRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      createdAt: backlogAt,
      status: "cancelled",
      // Sat genuinely queued for the full 14h43m — see finding-1 fix note.
      finishedAt: capacityAt,
    });
    await insertCapacityScheduledRetryRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      createdAt: capacityAt,
      scheduledRetryAt: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  // BLO-23624 review finding 1 (Ally, PR #1268): a terminal no-executable-turn
  // run's segment must close at its own `finishedAt`, not at whenever the next
  // run happens to have been created — otherwise a run that died in 60s
  // silently absorbs a multi-hour gap where *no run existed at all* into the
  // no-executable-turn bucket, hiding a genuinely unattended stall. Here a
  // dispatch-backlog run is cancelled almost immediately, then nothing is
  // dispatched again for ~7h. Under the pre-fix behaviour (segment closes at
  // the next run's `createdAt`) the 60s run would have absorbed the whole
  // gap and suppressed the trigger; with the fix, only its own 60s counts,
  // leaving the review eligible to fire.
  it("does not let a quickly-cancelled dispatch-backlog run absorb the unattended gap before the next run (BLO-23624 review finding 1)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const episodeStart = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });

    await insertNeverDispatchedRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      createdAt: episodeStart,
      status: "cancelled",
      finishedAt: new Date(episodeStart.getTime() + 60_000),
    });
    // Still genuinely queued when the episode ends — no `finishedAt`, so its
    // own short tail segment (createdAt to now) is legitimately open and
    // correctly counted, but it cannot retroactively cover the ~7h gap
    // before it either.
    await insertNeverDispatchedRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      createdAt: new Date(now.getTime() - 10 * 60 * 1000),
      status: "queued",
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
  });

  // BLO-23624 review finding 2 (Ally, PR #1268): `noExecutableTurnBreakdown`
  // reverses `latestRuns`, which the query orders `desc(createdAt), desc(id)`.
  // On a `createdAt` tie, only a matching `id` tie-break recovers the correct
  // "current" run — `Array.prototype.sort` is stable, so comparing on
  // `createdAt` alone leaves tied rows in their *input* order (already
  // `desc(id)`), and `chronological.at(-1)` would then pick the *lowest* id,
  // the exact inverse of `latestRuns[0]`. Explicit ids (rather than
  // `randomUUID()`) make the ordering deterministic instead of a ~50/50
  // flake. The capacity retry — due five days out — must win the tie and be
  // treated as current so the trigger stays suppressed; picking the ordinary
  // executed run instead would zero out the no-executable-turn bucket and
  // let the review fire.
  it("breaks a createdAt tie by id when picking the current run, not insertion order (BLO-23624 review finding 2)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const episodeStart = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt: episodeStart });

    // Lower id: must lose the tie-break and NOT be treated as current, even
    // though nothing else distinguishes insertion order from it.
    await db.insert(heartbeatRuns).values({
      id: "00000000-0000-4000-8000-000000000000",
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      status: "succeeded",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: episodeStart,
      finishedAt: new Date(episodeStart.getTime() + 30_000),
      livenessState: "advanced",
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
      createdAt: episodeStart,
      updatedAt: episodeStart,
    });

    // Higher id, identical createdAt: must win the tie-break and be treated
    // as the current, still-due capacity retry.
    await insertCapacityScheduledRetryRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      createdAt: episodeStart,
      scheduledRetryAt: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000),
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
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

  it("records one suppression per monitor wait instead of one per reconcile tick", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });
    const svc = productivityReviewService(db);
    const suppressionRows = () =>
      db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "issue.productivity_review_suppressed"));

    const first = await svc.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    expect(first.monitorScheduledSuppressed).toBe(1);
    expect(await suppressionRows()).toHaveLength(1);

    // Three further ticks 30s apart — the scheduler cadence. `elapsedMs` grows on each one, but
    // the monitor wait is unchanged, so none of them is a state change worth an audit row.
    for (const offsetMs of [30_000, 60_000, 90_000]) {
      const tick = await svc.reconcileProductivityReviews({
        now: new Date(now.getTime() + offsetMs),
        companyId: seeded.companyId,
      });
      // Still a suppression decision every tick — only the audit write is deduped.
      expect(tick.monitorScheduledSuppressed).toBe(1);
    }
    expect(await suppressionRows()).toHaveLength(1);

    // Re-arming to a different check time is a new wait and must be recorded.
    const rearmedNextCheckAt = new Date(monitorNextCheckAt.getTime() + 60 * 60 * 1000);
    await db
      .update(issues)
      .set({ monitorNextCheckAt: rearmedNextCheckAt })
      .where(eq(issues.id, seeded.issueId));

    const afterRearm = await svc.reconcileProductivityReviews({
      now: new Date(now.getTime() + 120_000),
      companyId: seeded.companyId,
    });
    expect(afterRearm.monitorScheduledSuppressed).toBe(1);
    const rows = await suppressionRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => (row.details as Record<string, unknown>).monitorNextCheckAt).sort()).toEqual(
      [monitorNextCheckAt.toISOString(), rearmedNextCheckAt.toISOString()].sort(),
    );
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
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
      thresholds: { longActiveMs: 60_000 },
    });

    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
  });

  it("does not raise long_active_duration when only a queued, never-dispatched run is stale but recent runs were actually dispatched", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const sevenHoursAgo = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: sevenHoursAgo,
    });

    // The run enqueued alongside the original checkout: still `queued`, never claimed,
    // `startedAt` null. Its age (7h) must not leak into the elapsed-time figure.
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 1,
      now: sevenHoursAgo,
      status: "queued",
      startedAt: null,
      nextAction: null,
    });

    // Real, dispatched work landing well inside the 6h window.
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 3,
      now: fourHoursAgo,
      withRunComments: true,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("does not raise long_active_duration when the current execution holder is still queued and has never started (BLO-22016 / BLO-18846)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: twelveHoursAgo,
    });

    await pinExecutionRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      status: "queued",
      lockedAt: twelveHoursAgo,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  // BLO-22436 population 3, live reproduction (BLO-23179 / run `e646fcdb`): a run enqueued
  // 3s after its PR merged sat `queued` for 6h05m against `maxConcurrentRuns: 5` with every
  // slot occupied, and mid-gap the detector filed BLO-27289 reporting a "6h 0m active
  // episode". Every minute of it was queue latency.
  //
  // Deliberately does NOT pin the queued run via `pinExecutionRun`, unlike the BLO-22016
  // test above, and that is the whole point of keeping this case separate: `issues
  // .executionRunId` is written only once the claim transaction observes the run already
  // `running` (heartbeat.ts, the `lockedRun?.status !== "running"` guard), so an ordinary
  // never-dispatched run is *not* the execution holder. Both single-row helpers therefore
  // see nothing — `currentHolderNeverDispatched` cannot fire and `nonLiveExecutionHoldSince`
  // has no hold to clamp — and before BLO-25722 the episode kept accruing against the
  // *previous* run's `startedAt` for the entire queue wait. Verified against master
  // (`dc466350e`): this seeding files a review, `expected 1 to be +0`.
  it("does not raise long_active_duration while the assignee's next run sits queued and undispatched (BLO-22436 population 3 / BLO-23179)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const checkoutAt = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    const dispatchedAt = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const enqueuedAt = new Date(now.getTime() - 6 * 60 * 60 * 1000 - 50 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: checkoutAt,
    });

    // The previous run: dispatched, executed, commented, finished. It anchors the episode
    // at 7h ago — past the 6h threshold on raw wall-clock.
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 1,
      now: dispatchedAt,
      startedAt: dispatchedAt,
      withRunComments: true,
    });

    // The successor, enqueued 10 minutes later and never given a pod. Carries no
    // `errorCode` and is not terminal, so neither never-executed filter (BLO-21769's
    // zero-token test, BLO-22436's `issue_dependencies_blocked` test) can reach it —
    // this population is caught on the queued-and-undispatched signature or not at all.
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 1,
      now: enqueuedAt,
      status: "queued",
      startedAt: null,
      livenessState: null,
      errorCode: null,
      nextAction: null,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  // Scope control for the above. The queue-wait exclusion is confined to the
  // elapsed-duration path: `no_comment_streak` counts terminal, turn-executing runs, so a
  // dispatch enqueued *after* those runs was never pending for the flagged interval and
  // does not excuse them. Suppressing the streak on any pending dispatch would blind the
  // detector on every actively-woken issue, since a fresh `queued` run is the normal
  // post-wake state.
  it("still raises no_comment_streak when a genuinely silent executed streak is followed by a queued run (BLO-22436 population 3 scope)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const streakAt = new Date(now.getTime() - 90 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress" });

    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now: streakAt,
      spacingMs: 10 * 60 * 1000,
    });

    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 1,
      now: new Date(now.getTime() - 30 * 60 * 1000),
      status: "queued",
      startedAt: null,
      livenessState: null,
      nextAction: null,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `no_comment_streak`");
  });

  // Contrast case: no run row exists at all since checkout — nothing was even attempted,
  // as distinct from "a run was queued but never started" above. This is the existing,
  // deliberately-tested "unattended episode" scenario (see the monitor-gating tests
  // below, e.g. "reports the whole episode as unattended when no monitor was ever
  // armed") and must keep firing on raw wall-clock time; the BLO-22016 fix must not
  // desensitize this case just because it also involves zero dispatched runs.
  it("still raises long_active_duration when a checked-out issue has no run at all, unlike a queued-never-started run", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: twelveHoursAgo,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
  });

  it("still creates a long_active_duration review once the run actually starts and runs past the threshold", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const checkoutAt = new Date(now.getTime() - 14 * 60 * 60 * 1000);
    // BLO-27698 B3: was 7h. The trigger now measures the *unattended* bucket, and
    // this run carries no liveness stamps, so `runLiveInterval` credits it the 2h
    // silence grace from its dispatch and the rest of the episode is unattended.
    // At a 7h episode that left a 5h residue — under the 6h bar — so the fixture
    // was measuring the silence grace rather than the property it names. Moved to
    // 9h so the unattended residue (7h) clears the bar on its own, which is what
    // "runs past the threshold" has to mean once executing time is its own bucket.
    // The BLO-22016 contrast with the queued-never-started case above is unchanged:
    // that one is withheld for having no dispatch at all, this one fires because it
    // has one.
    const dispatchedAt = new Date(now.getTime() - 9 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: checkoutAt,
    });

    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 1,
      now: dispatchedAt,
      status: "running",
      startedAt: dispatchedAt,
      nextAction: null,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
  });

  it("anchors elapsed time to the true max(startedAt) when creation order and dispatch order diverge", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 8 * 60 * 60 * 1000),
    });

    // Created earlier, but dispatched last — the true most recent dispatch.
    const olderCreatedAt = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const olderRunId = randomUUID();
    // Created later than the run above, but dispatched shortly after creation — the run a
    // createdAt-ordered `.find()` would hit first.
    const newerCreatedAt = new Date(now.getTime() - 6 * 60 * 60 * 1000 - 50 * 60_000);
    const newerRunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      {
        id: olderRunId,
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        status: "succeeded",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: new Date(now.getTime() - 30 * 60_000),
        finishedAt: new Date(now.getTime() - 20 * 60_000),
        contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
        livenessState: "advanced",
        nextAction: null,
        createdAt: olderCreatedAt,
        updatedAt: olderCreatedAt,
      },
      {
        id: newerRunId,
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        status: "succeeded",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: new Date(now.getTime() - 6 * 60 * 60 * 1000 - 5 * 60_000),
        finishedAt: new Date(now.getTime() - 6 * 60 * 60 * 1000),
        contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
        livenessState: "advanced",
        nextAction: null,
        createdAt: newerCreatedAt,
        updatedAt: newerCreatedAt,
      },
    ]);

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("recovers a Next line from an assignee comment instead of reporting 'none recorded'", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const runs = await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
      nextAction: null,
    });
    await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      authorAgentId: seeded.coderId,
      createdByRunId: runs[0]?.id,
      body: "Made progress on the import job.\n\nNext: verify the retry backoff against the new queue depth metric.",
      createdAt: now,
      updatedAt: now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `high_churn`");
    expect(review?.description).not.toContain("Current next action: none recorded");
    expect(review?.description).toContain(
      "Current next action: verify the retry backoff against the new queue depth metric.",
    );
  });

  it("recovers a Next line from an assignee comment with no createdByRunId link", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
      nextAction: null,
    });
    await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      authorAgentId: seeded.coderId,
      createdByRunId: null,
      body: "Made progress on the import job.\n\nNext: verify the retry backoff against the new queue depth metric.",
      createdAt: now,
      updatedAt: now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    // A comment with no `createdByRunId` cannot break the no-comment streak (it is not a
    // "run-created issue comment"), so this fires `no_comment_streak` rather than
    // `high_churn` — that trigger choice is unrelated to what this test is verifying.
    expect(review?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(review?.description).not.toContain("Current next action: none recorded");
    expect(review?.description).toContain(
      "Current next action: verify the retry backoff against the new queue depth metric.",
    );
  });

  it("recovers a Next line even after newer non-matching assignee comments", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
      nextAction: null,
    });
    const matchingCommentAt = new Date(now.getTime() - 20 * 60_000);
    await db.insert(issueComments).values([
      {
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        authorAgentId: seeded.coderId,
        createdByRunId: null,
        body: "Made progress on the import job.\n\nNext: verify the retry backoff against the new queue depth metric.",
        createdAt: matchingCommentAt,
        updatedAt: matchingCommentAt,
      },
      ...Array.from({ length: 6 }, (_, index) => {
        const createdAt = new Date(now.getTime() - (6 - index) * 60_000);
        return {
          companyId: seeded.companyId,
          issueId: seeded.issueId,
          authorAgentId: seeded.coderId,
          createdByRunId: null,
          body: `Status update ${index + 1}: still validating the import job.`,
          createdAt,
          updatedAt: createdAt,
        };
      }),
    ]);

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).not.toContain("Current next action: none recorded");
    expect(review?.description).toContain(
      "Current next action: verify the retry backoff against the new queue depth metric.",
    );
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
        longActiveMs: 60_000,
      },
    });

    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
  });

  it("suppresses a monitor still queued behind one remaining scheduler batch", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 6 * 60_000 - 30_000);
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

  // BLO-25877: `currentPendingMonitorForReviewSuppression` issues its own, fresher
  // `getCurrentIssue` read than the one evidence assembly saw. A monitor that fires
  // in that gap clears `monitorNextCheckAt` to null — `buildIssueMonitorTriggeredPatch`
  // clears it atomically with setting `monitorLastTriggeredAt` — so the suppression
  // check used to see "nothing pending" on its very first guard, even though the fire
  // itself is the strongest possible evidence the issue is attended (it enqueues a
  // successor run by construction). This is the exact BLO-25527 replay: fails on
  // pre-fix code because `deliberatePendingMonitor` returned null purely because
  // `monitorNextCheckAt` was null, never looking at how recently it got that way.
  it("suppresses long-active reviews for a monitor that fired within grace and cleared monitorNextCheckAt", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorLastTriggeredAt = new Date(now.getTime() - 2_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - (41 * 60 * 60 * 1000)), // 1d 17h episode
      monitorNextCheckAt: null,
      monitorScheduledBy: "assignee",
      monitorLastTriggeredAt,
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
      monitorNextCheckAt: null,
      monitorScheduledBy: "assignee",
      monitorLastTriggeredAt: monitorLastTriggeredAt.toISOString(),
    });
  });

  // BLO-25877 AC: the just-fired suppression above must stay bounded, mirroring
  // BLO-22331 AC2 — a monitor that fired long ago and was never re-armed since is
  // exactly the unattended-stall signal this trigger exists to catch, not something
  // an old firing should shield forever.
  it("still fires long-active review for a monitor that fired long ago and was never re-armed", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 41 * 60 * 60 * 1000),
      monitorNextCheckAt: null,
      monitorScheduledBy: "assignee",
      monitorLastTriggeredAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
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

  // BLO-25877 defect 2: `longActive` used to compare raw `elapsedMs` against the
  // threshold, ignoring the monitor-gated split computed for the report text. A
  // monitor that lapsed early in a long episode and was never serviced again must
  // still subtract the measured (non-upper-bound) gated span, leaving the genuine
  // unattended remainder to trip the threshold.
  it("subtracts only the measured monitor-gated span from the long-active predicate", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const activeStartedAt = new Date(now.getTime() - 20 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: activeStartedAt,
      monitorNextCheckAt: new Date(activeStartedAt.getTime() + 5 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("5m monitor-gated, 19h 55m unattended");
    expect(review?.description).toContain("monitor lapsed at");
    expect(review?.description).toContain("never re-armed");
  });

  // BLO-22887 verifying-signal cell 1. The three tests below deliberately reuse
  // the fixture immediately above, because that fixture reproduces the *shape*
  // of the reported defect — monitor lapses early, is never re-armed, long
  // unattended remainder — on an issue the control plane independently holds
  // dependency-blocked, which is how BLO-22703 fired `long_active_duration` on
  // BLO-21016. Its shape, not its numbers: this fixture's own accounting is
  // `5m monitor-gated, 19h 55m unattended` (asserted in cell 3), not
  // BLO-22703's. Keeping the fixture byte-identical and adding only the blocker
  // is what makes these a control/treatment pair rather than three unrelated
  // scenarios.
  //
  // The BLO-22436 suppression tests all drive `no_comment_streak`, so until now
  // `long_active_duration` — the one trigger this ticket was filed about, and
  // the one whose elapsed accounting crosses into the monitor-lapse subsystem —
  // had no generation-gate coverage at all. The gate is trigger-set-generic, so
  // this is a regression guard on an intersection, not a new behaviour.
  it("suppresses a long_active_duration review for a dependency-blocked issue whose monitor deliberately lapsed (BLO-22887)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const activeStartedAt = new Date(now.getTime() - 20 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: activeStartedAt,
      monitorNextCheckAt: new Date(activeStartedAt.getTime() + 5 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    await addBlocker({
      companyId: seeded.companyId,
      issuePrefix: seeded.issuePrefix,
      blockedIssueId: seeded.issueId,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    // Pins *which* mechanism suppressed it. `created: 0` alone is satisfied by
    // the long-active predicate never firing — i.e. by the fixture silently
    // rotting into a no-op — which is the failure mode that would make this
    // test pass for the wrong reason.
    expect(result.dependencyBlockedSuppressed).toBe(1);
    // Pins gate *ordering*, not monitor state: the dependency gate `continue`s
    // before the monitor gate, so this cannot fail while the assertion above
    // holds. Kept here as the ordering pin; cell 2 omits it as redundant.
    expect(result.monitorScheduledSuppressed).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  // BLO-22887 verifying-signal cell 2. The AC names the signal as
  // `scheduledRetryReason: dependency_blocked`, which is real
  // (`DEP_BLOCKED_RETRY_REASON`, heartbeat.ts) but is NOT what the detector
  // gates on — the gate reads `listDependencyReadiness`, i.e. the `blockedBy`
  // edge. Those are not independent: the park is only ever written with a
  // non-empty `unresolvedBlockerIssueIds` (heartbeat.ts, dep-blocked wake
  // deferral), so the retry reason is a downstream marker of the same graph
  // state, and BLO-21016 carried both at once exactly as this fixture does.
  //
  // The park is placed OVERDUE only because that is the state a real
  // `issue_dependencies_blocked` park reaches once its due time passes — the
  // position is not load-bearing. The BLO-19848/BLO-23248 pinning path cannot
  // classify this row in either position: `classifyNoExecutableTurnRun`
  // returns null for a `scheduled_retry` whose reason is not
  // `ccrotate_capacity` and whose errorCode is not `rate_limit_exhausted`
  // (productivity-review.ts, `isCapacityClass`), and this cell overrides both
  // helper defaults. The only other `scheduledRetryAt` consumer,
  // `liveSegmentStartedAt`, needs `status === "running"` plus an
  // `issue.executionRunId` the helper deliberately leaves null. So the park row
  // is inert with respect to the gate under test, and this cell must land on
  // the same counters as cell 1: asserting invariance under the AC's named
  // signal is the point — it is AC fidelity, not a second suppression path. The
  // near-duplicate of cell 1 is deliberate.
  it("suppresses a long_active_duration review for an issue parked on an overdue dependency_blocked retry (BLO-22887)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const activeStartedAt = new Date(now.getTime() - 20 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: activeStartedAt,
      monitorNextCheckAt: new Date(activeStartedAt.getTime() + 5 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    await addBlocker({
      companyId: seeded.companyId,
      issuePrefix: seeded.issuePrefix,
      blockedIssueId: seeded.issueId,
    });
    await insertCapacityScheduledRetryRun({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      scheduledRetryAt: new Date(now.getTime() - 60 * 60 * 1000),
      scheduledRetryReason: "dependency_blocked",
      errorCode: "issue_dependencies_blocked",
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.dependencyBlockedSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  // BLO-22887 verifying-signal cell 3 (over-suppression guard). Named
  // explicitly because cells 1 and 2 are both "no review emitted": a change
  // that simply stopped emitting `long_active_duration` would satisfy them
  // while disabling the detector. This is the same fixture with the blocker
  // resolved rather than absent, so it also pins that the gate reads blocker
  // *state* and not the mere existence of a relation row.
  it("still emits the long_active_duration review once the blocker is resolved (BLO-22887)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const activeStartedAt = new Date(now.getTime() - 20 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: activeStartedAt,
      monitorNextCheckAt: new Date(activeStartedAt.getTime() + 5 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    await addBlocker({
      companyId: seeded.companyId,
      issuePrefix: seeded.issuePrefix,
      blockedIssueId: seeded.issueId,
      blockerStatus: "done",
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.dependencyBlockedSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
    expect(review?.description).toContain("5m monitor-gated, 19h 55m unattended");
    // A resolved blocker leaves no unresolved edge, so the BLO-22887 bucket
    // must not render — the line's presence is itself the signal.
    expect(review?.description).not.toContain("Dependency accounting");
  });

  // BLO-25877 defect 2 regression guard: the still-armed branch reports
  // `unattendedMs: 0` as a deliberate, documented upper bound (no arm-time column
  // exists), not a measured value. Wiring it into the predicate wholesale would make
  // `long_active_duration` structurally unfireable for any issue with a monitor armed
  // however briefly — asserting only `created: 0` here would not catch that
  // regression, since a wrongly-zeroed predicate also produces `created: 0`, just via
  // "never triggered" instead of "triggered, then suppressed". Assert
  // `monitorScheduledSuppressed: 1` to distinguish the two.
  it("keeps the still-armed branch on the pending-monitor gate instead of feeding unattendedMs:0 into the predicate", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 15 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() + 60_000),
      monitorScheduledBy: "assignee",
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.monitorScheduledSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  // BLO-27698 A4 — suppression and reporting must agree on what "lapsed" means.
  // `deliberatePendingMonitor` already treats a monitor inside
  // `monitorLapseServiceGraceMs` as pending; `monitorGatingBreakdown` did not, so a
  // monitor 20s past due reported "never re-armed" — reading to a manager as "nobody
  // is watching" when dispatch is merely still due. Reachable whenever the
  // suppression gates do not hold (here: a non-suppression-actor monitor), which is
  // exactly when the report is rendered and read.
  it("does not report a monitor inside the dispatch service grace as never re-armed", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 20_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorLastTriggeredAt: null,
      monitorScheduledBy: null,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      // The 20s unattended residue is below the default long-active bar, so shrink
      // the bar to render a report at all. Grace stays at its default 330s, which is
      // the constant under test.
      thresholds: { longActiveMs: 10_000 },
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).not.toContain("never re-armed");
    expect(review?.description).toContain(
      `20s unattended (monitor came due at ${monitorNextCheckAt.toISOString()} and is still inside the dispatch service grace`,
    );
  });

  // BLO-27698 A4 boundedness — the converse, and the guard against A4 being applied
  // as "recently due" rather than "inside grace". Same 20s-past-due monitor with the
  // grace shrunk below 20s is genuinely unserviced, and must keep reporting the lapse.
  it("still reports never re-armed once the monitor is past the dispatch service grace", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 20_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorLastTriggeredAt: null,
      monitorScheduledBy: null,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { longActiveMs: 10_000, monitorLapseServiceGraceMs: 5_000 },
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain(
      `20s unattended (monitor lapsed at ${monitorNextCheckAt.toISOString()}, never re-armed)`,
    );
  });

  it("does not renew backlog grace forever behind a non-draining predecessor", async () => {
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
      title: "Non-draining predecessor monitor",
      status: "in_review" as const,
      priority: "medium" as const,
      assigneeAgentId: seeded.coderId,
      monitorNextCheckAt,
      monitorScheduledBy: "assignee" as const,
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
        longActiveMs: 60_000,
      },
    });

    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
  });

  it("does not renew backlog grace forever behind repeated predecessor claims", async () => {
    const firstPass = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(firstPass.getTime() - 10 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(firstPass.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });
    const predecessorId = randomUUID();
    await db.insert(issues).values({
      id: predecessorId,
      companyId: seeded.companyId,
      title: "Repeatedly claimed predecessor monitor",
      status: "in_review" as const,
      priority: "medium" as const,
      assigneeAgentId: seeded.coderId,
      monitorNextCheckAt,
      monitorScheduledBy: "assignee" as const,
      monitorWakeRequestedAt: new Date(firstPass.getTime() - 4 * 60_000),
      issueNumber: 20,
      identifier: `${seeded.issuePrefix}-20`,
      createdAt: seeded.createdAt,
      updatedAt: new Date(seeded.createdAt.getTime() - 1_000),
    });

    const first = await productivityReviewService(db).reconcileProductivityReviews({
      now: firstPass,
      companyId: seeded.companyId,
      thresholds: {
        monitorLapseServiceGraceMs: 60_000,
        monitorSchedulerIntervalMs: 60_000,
        monitorDispatchBatchSize: 50,
      },
    });

    expect(first.created).toBe(0);
    expect(first.monitorScheduledSuppressed).toBe(1);

    const secondPass = new Date(firstPass.getTime() + 10 * 60_000);
    await db
      .update(issues)
      .set({
        monitorWakeRequestedAt: new Date(secondPass.getTime() - 30_000),
        updatedAt: new Date(secondPass.getTime() - 30_000),
      })
      .where(eq(issues.id, predecessorId));

    const second = await productivityReviewService(db).reconcileProductivityReviews({
      now: secondPass,
      companyId: seeded.companyId,
      thresholds: {
        monitorLapseServiceGraceMs: 60_000,
        monitorSchedulerIntervalMs: 60_000,
        monitorDispatchBatchSize: 50,
        longActiveMs: 60_000,
      },
    });

    expect(second.created).toBe(1);
    expect(second.monitorScheduledSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
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

  it("keeps equal-time fresh-claimed predecessors ahead after scheduler claim updates updatedAt", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 10 * 60_000);
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
        title: `Fresh claimed equal-time predecessor ${index + 1}`,
        status: "in_review" as const,
        priority: "medium" as const,
        assigneeAgentId: seeded.coderId,
        monitorNextCheckAt,
        monitorScheduledBy: "assignee" as const,
        monitorWakeRequestedAt: now,
        issueNumber: index + 20,
        identifier: `${seeded.issuePrefix}-${index + 20}`,
        createdAt: seeded.createdAt,
        updatedAt: now,
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

  it("revalidates monitor suppression after the final pre-create hook", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 10 * 60_000);
    const monitorWakeRequestedAt = new Date(now.getTime() - 30_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });

    const result = await productivityReviewService(db, {
      async beforeCreateOrUpdateReview(evidence) {
        if (evidence.sourceIssue.id !== seeded.issueId) return;
        await db
          .update(issues)
          .set({ monitorWakeRequestedAt, updatedAt: monitorWakeRequestedAt })
          .where(eq(issues.id, seeded.issueId));
      },
    }).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      // BLO-25877: 10m unattended residue must clear `longActiveMs` for
      // `collectEvidence` to reach the monitor-suppression hooks under test here.
      thresholds: { monitorLapseServiceGraceMs: 60_000, longActiveMs: 60_000 },
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

  it("guards monitor suppression after final revalidation until issue insert", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 10 * 60_000);
    const monitorWakeRequestedAt = new Date(now.getTime() - 30_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });

    const result = await productivityReviewService(db, {
      async beforeCreateReviewIssueInsert(evidence) {
        if (evidence.sourceIssue.id !== seeded.issueId) return;
        await db
          .update(issues)
          .set({ monitorWakeRequestedAt, updatedAt: monitorWakeRequestedAt })
          .where(eq(issues.id, seeded.issueId));
      },
    }).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000, longActiveMs: 60_000 },
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

  it("guards monitor suppression before Linear identifier side effects", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 10 * 60_000);
    const monitorWakeRequestedAt = new Date(now.getTime() - 30_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });
    await db
      .update(companies)
      .set({ identifierProvider: "linear" })
      .where(eq(companies.id, seeded.companyId));

    const result = await productivityReviewService(db, {
      async beforeCreateReviewIssueInsert(evidence) {
        if (evidence.sourceIssue.id !== seeded.issueId) return;
        await db
          .update(issues)
          .set({ monitorWakeRequestedAt, updatedAt: monitorWakeRequestedAt })
          .where(eq(issues.id, seeded.issueId));
      },
    }).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000, longActiveMs: 60_000 },
    });

    expect(result.failed).toBe(0);
    expect(result.created).toBe(0);
    expect(result.monitorScheduledSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("revalidates fresh predecessor claims before review issue insert", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 10 * 60_000);
    const predecessorClaimedAt = new Date(now.getTime() - 30_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });
    const predecessorId = randomUUID();
    await db.insert(issues).values({
      id: predecessorId,
      companyId: seeded.companyId,
      title: "Fresh predecessor in final window",
      status: "in_review" as const,
      priority: "medium" as const,
      assigneeAgentId: seeded.coderId,
      monitorNextCheckAt,
      monitorScheduledBy: "assignee" as const,
      issueNumber: 20,
      identifier: `${seeded.issuePrefix}-20`,
      createdAt: seeded.createdAt,
      updatedAt: new Date(seeded.createdAt.getTime() - 1_000),
    });

    const result = await productivityReviewService(db, {
      async beforeCreateReviewIssueInsert(evidence) {
        if (evidence.sourceIssue.id !== seeded.issueId) return;
        await db
          .update(issues)
          .set({ monitorWakeRequestedAt: predecessorClaimedAt, updatedAt: predecessorClaimedAt })
          .where(eq(issues.id, predecessorId));
      },
    }).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: {
        monitorLapseServiceGraceMs: 60_000,
        monitorSchedulerIntervalMs: 60_000,
        monitorDispatchBatchSize: 50,
        longActiveMs: 60_000,
      },
    });

    expect(result.created).toBe(0);
    expect(result.monitorScheduledSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("does not block monitor claims behind final review issue creation", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 10 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });
    const predecessorId = randomUUID();
    await db.insert(issues).values({
      id: predecessorId,
      companyId: seeded.companyId,
      title: "Predecessor waiting while review creates",
      status: "in_review" as const,
      priority: "medium" as const,
      assigneeAgentId: seeded.coderId,
      monitorNextCheckAt,
      monitorScheduledBy: "assignee" as const,
      issueNumber: 20,
      identifier: `${seeded.issuePrefix}-20`,
      createdAt: seeded.createdAt,
      updatedAt: new Date(seeded.createdAt.getTime() - 1_000),
    });

    const finalRevalidationReady = deferred();
    const releaseReviewCreation = deferred();
    const reconcile = productivityReviewService(db, {
      async beforeFinalMonitorSuppressionRevalidation(evidence) {
        if (evidence.sourceIssue.id !== seeded.issueId) return;
        finalRevalidationReady.resolve();
        await releaseReviewCreation.promise;
      },
    }).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: {
        monitorLapseServiceGraceMs: 60_000,
        monitorSchedulerIntervalMs: 60_000,
        monitorDispatchBatchSize: 50,
        longActiveMs: 60_000,
      },
    });

    await finalRevalidationReady.promise;
    await db
      .update(issues)
      .set({ monitorWakeRequestedAt: now, updatedAt: now })
      .where(eq(issues.id, predecessorId));

    const [predecessorDuringReview] = await db
      .select({ monitorWakeRequestedAt: issues.monitorWakeRequestedAt })
      .from(issues)
      .where(eq(issues.id, predecessorId));
    expect(predecessorDuringReview?.monitorWakeRequestedAt?.toISOString()).toBe(now.toISOString());

    releaseReviewCreation.resolve();
    const result = await reconcile;
    expect(result.created).toBe(0);
    expect(result.monitorScheduledSuppressed).toBe(1);
  });

  it("does not let post-reservation monitor claims invalidate the reserved review", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const monitorNextCheckAt = new Date(now.getTime() - 10 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });

    const reservationReady = deferred<string>();
    const releaseIdentifierAllocation = deferred();
    const reconcile = productivityReviewService(db, {
      async afterFinalMonitorReviewReservation(evidence, review) {
        if (evidence.sourceIssue.id !== seeded.issueId) return;
        reservationReady.resolve(review.id);
        await releaseIdentifierAllocation.promise;
      },
    }).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: {
        monitorLapseServiceGraceMs: 60_000,
        monitorSchedulerIntervalMs: 60_000,
        monitorDispatchBatchSize: 50,
        longActiveMs: 60_000,
      },
    });

    const reviewId = await reservationReady.promise;
    const [reserved] = await db
      .select({ identifier: issues.identifier, issueNumber: issues.issueNumber })
      .from(issues)
      .where(eq(issues.id, reviewId));
    expect(reserved).toMatchObject({ identifier: null, issueNumber: null });

    await db
      .update(issues)
      .set({ monitorWakeRequestedAt: now, updatedAt: now })
      .where(eq(issues.id, seeded.issueId));

    const [sourceAfterTick] = await db
      .select({ monitorWakeRequestedAt: issues.monitorWakeRequestedAt })
      .from(issues)
      .where(eq(issues.id, seeded.issueId));
    expect(sourceAfterTick?.monitorWakeRequestedAt?.toISOString()).toBe(now.toISOString());

    releaseIdentifierAllocation.resolve();
    const result = await reconcile;
    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);

    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.id).toBe(reviewId);
    expect(reviews[0]?.identifier).toBe(`${seeded.issuePrefix}-2`);
  });

  it("recovers a stale reserved review without an identifier", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const reservedAt = new Date(now.getTime() - 10 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() - 10 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    const reviewId = randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: seeded.companyId,
      title: "Review productivity for reserved source",
      description: "Reserved before identifier allocation",
      status: "todo",
      priority: "medium",
      parentId: seeded.issueId,
      assigneeAgentId: seeded.managerId,
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      requestDepth: 1,
      createdAt: reservedAt,
      updatedAt: reservedAt,
      lastActivityAt: reservedAt,
    });

    const wakeups: Array<{ agentId: string; opts: unknown }> = [];
    const result = await productivityReviewService(db, {
      async enqueueWakeup(agentId, opts) {
        wakeups.push({ agentId, opts });
        return { id: randomUUID() };
      },
    }).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000 },
    });

    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);
    const [review] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, reviewId));
    expect(review?.identifier).toBe(`${seeded.issuePrefix}-2`);
    expect(review?.issueNumber).toBe(2);
    expect(review?.updatedAt.toISOString()).toBe(now.toISOString());
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.agentId).toBe(seeded.managerId);
    expect(wakeups[0]?.opts).toMatchObject({
      idempotencyKey: `productivity-review-created:${reviewId}`,
    });

    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_created"));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.entityId).toBe(reviewId);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_assignment_wake_enqueued")).toBe(1);
  });

  it("preserves a Linear-backed reservation when local finalization fails after lookup", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const reservedAt = new Date(now.getTime() - 10 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() - 10 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    await db
      .update(companies)
      .set({ identifierProvider: "linear" })
      .where(eq(companies.id, seeded.companyId));
    const [plugin] = await db
      .insert(plugins)
      .values({
        pluginKey: "paperclip-plugin-linear",
        packageName: "@kkroo/paperclip-plugin-linear",
        version: "0.9.3",
        manifestJson: {} as never,
      })
      .returning();
    await db.insert(pluginState).values([
      {
        pluginId: plugin.id,
        scopeKind: "instance",
        stateKey: "oauth-team-id",
        valueJson: "linear-team-id",
      },
      {
        pluginId: plugin.id,
        scopeKind: "instance",
        stateKey: "oauth-token",
        valueJson: "linear-oauth-token",
      },
    ]);
    const reviewId = await insertProductivityReview({ seeded, createdAt: reservedAt });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          data: {
            issue: {
              id: reviewId,
              identifier: "LIN-7777",
              url: "https://linear.app/blockc/issue/LIN-7777/title-slug",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await db.execute(sql`
      alter table linear_issue_links
      add constraint test_reject_productivity_review_linear_link
      check (false)
    `);

    try {
      const failed = await productivityReviewService(db).reconcileProductivityReviews({
        now,
        companyId: seeded.companyId,
        thresholds: { monitorLapseServiceGraceMs: 60_000 },
      });
      expect(failed.failed).toBe(1);
      const [reserved] = await db
        .select({ id: issues.id, identifier: issues.identifier, issueNumber: issues.issueNumber })
        .from(issues)
        .where(eq(issues.id, reviewId));
      expect(reserved).toMatchObject({ id: reviewId, identifier: null, issueNumber: null });
    } finally {
      await db.execute(sql`
        alter table linear_issue_links
        drop constraint test_reject_productivity_review_linear_link
      `);
    }

    // BLO-33477: a failed finalize now backs the reservation off for a full
    // stale interval so it cannot hold a slot in the window. The row is
    // re-admitted once it is stale again, so this second reconcile advances the
    // clock past PRODUCTIVITY_REVIEW_RESERVATION_STALE_MS rather than replaying
    // the same instant.
    const recovered = await productivityReviewService(db).reconcileProductivityReviews({
      now: new Date(now.getTime() + 5 * 60_000 + 1_000),
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000 },
    });
    expect(recovered.created).toBe(1);
    const [review] = await db
      .select({ id: issues.id, identifier: issues.identifier, issueNumber: issues.issueNumber })
      .from(issues)
      .where(eq(issues.id, reviewId));
    expect(review).toMatchObject({ id: reviewId, identifier: "LIN-7777", issueNumber: 7777 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });

  it("recovers a stale reserved review only once when reconcilers race", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const reservedAt = new Date(now.getTime() - 10 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() - 10 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    const reviewId = await insertProductivityReview({ seeded, createdAt: reservedAt });

    const wakeups: Array<{ agentId: string; opts: unknown }> = [];
    let waitingReconcilers = 0;
    const bothReconcilersReady = deferred();
    const releaseReconcilers = deferred();
    const finalizeWinnerWaiting = deferred();
    const releaseFinalizeWinner = deferred();
    const service = productivityReviewService(db, {
      async beforeStaleReservationRecoveryFinalize(review, sourceIssue) {
        if (review.id !== reviewId || sourceIssue.id !== seeded.issueId) return;
        waitingReconcilers += 1;
        if (waitingReconcilers === 2) bothReconcilersReady.resolve();
        await releaseReconcilers.promise;
      },
      async afterStaleReservationRecoveryFinalize(review, sourceIssue, finalized) {
        if (review.id !== reviewId || sourceIssue.id !== seeded.issueId) return;
        if (finalized) {
          finalizeWinnerWaiting.resolve();
          await releaseFinalizeWinner.promise;
          return;
        }
        await finalizeWinnerWaiting.promise;
      },
      async enqueueWakeup(agentId, opts) {
        wakeups.push({ agentId, opts });
        releaseFinalizeWinner.resolve();
        return { id: randomUUID() };
      },
    });

    const first = service.reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000 },
    });
    const second = service.reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000 },
    });
    await bothReconcilersReady.promise;
    releaseReconcilers.resolve();

    const results = await Promise.all([first, second]);
    expect(results[0].created + results[1].created).toBe(1);
    expect(results[0].existing + results[1].existing).toBe(1);
    expect(wakeups).toHaveLength(1);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_created")).toBe(1);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_assignment_wake_enqueued")).toBe(1);

    const [review] = await db.select().from(issues).where(eq(issues.id, reviewId));
    expect(review?.identifier).toBe(`${seeded.issuePrefix}-2`);
    expect(review?.issueNumber).toBe(2);
  });

  it("holds a stale reservation out of the window while its finalize keeps throwing", async () => {
    // BLO-33477 AC3. The catch was the one path out of the recovery loop that
    // left the row untouched, so a deterministically-failing finalize kept its
    // `updatedAt` and re-selected at the head of `asc(updatedAt) LIMIT 250` on
    // every pass — MAX_CANDIDATE_ISSUES of them would pin the window and starve
    // every newer stale reservation behind it.
    //
    // The catch now sets `updatedAt = now`, which fails the query's own
    // `updatedAt < staleCutoff` predicate: the row is not re-ordered within the
    // window, it leaves the window, and cannot occupy a slot until it is stale
    // again. Both halves — excluded during the back-off, retried after it — are
    // asserted here.
    const now = new Date("2026-04-28T12:00:00.000Z");
    const staleMs = 5 * 60_000;
    const reservedAt = new Date(now.getTime() - 10 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() - 10 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    const reviewId = await insertProductivityReview({ seeded, createdAt: reservedAt });

    let attempts = 0;
    const service = productivityReviewService(db, {
      async beforeStaleReservationRecoveryFinalize(review) {
        if (review.id !== reviewId) return;
        attempts += 1;
        throw new Error("finalize is deterministically broken for this reservation");
      },
    });
    const reconcileAt = (at: Date) =>
      service.reconcileProductivityReviews({
        now: at,
        companyId: seeded.companyId,
        thresholds: { monitorLapseServiceGraceMs: 60_000 },
      });
    const scanKey = async () =>
      db
        .select({ updatedAt: issues.updatedAt })
        .from(issues)
        .where(eq(issues.id, reviewId))
        .then((rows) => rows[0]?.updatedAt);

    const first = await reconcileAt(now);
    expect(first.failed).toBe(1);
    expect(attempts).toBe(1);
    // Backed off to this pass's `now`, which is >= `staleCutoff` by definition.
    expect(await scanKey()).toEqual(now);

    // Held out of the window: not merely re-ordered within it, so it is not
    // attempted at all and consumes no slot.
    const second = await reconcileAt(new Date(now.getTime() + 1_000));
    expect(second.failed).toBe(0);
    expect(attempts).toBe(1);
    expect(await scanKey()).toEqual(now);

    // Stale again -> re-admitted and retried, so a transient failure is not
    // punished beyond one stale interval.
    const thirdAt = new Date(now.getTime() + staleMs + 1_000);
    const third = await reconcileAt(thirdAt);
    expect(third.failed).toBe(1);
    expect(attempts).toBe(2);
    expect(await scanKey()).toEqual(thirdAt);

    // The reservation itself is untouched apart from the scan key.
    const [review] = await db.select().from(issues).where(eq(issues.id, reviewId));
    expect(review?.identifier).toBeNull();
    expect(review?.issueNumber).toBeNull();
    expect(review?.status).toBe("todo");
  });

  // BLO-33477 AC3, capped-window form. The test above proves a failing row
  // leaves the window; this one proves what that buys — the tail is reached
  // even when a whole window of deterministically-failing reservations is in
  // front of it.
  //
  // The bound is TWO eligible passes, not one, and asserting one would be red
  // against correct code: on the first pass the cohort is still eligible, sorts
  // ahead of the target, and the LIMIT cuts it. The catch then backs all 250 of
  // them off to that pass's `now`, which is >= the next pass's `staleCutoff`,
  // so on pass two the cohort is not in the candidate set at all — whatever its
  // size, and whether the target's key is older or newer than theirs.
  //
  // That is the refutation of "the failures stay ahead indefinitely": they are
  // not ahead, they are gone. Pre-fix the cohort kept its original `reservedAt`
  // — a fixed key, always <= any newer row's — and this test never goes green.
  it("recovers a stale reservation behind a full window of failing ones (BLO-33477)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const staleMs = 5 * 60_000;
    const staleCutoff = new Date(now.getTime() - staleMs); // c_1 = 11:55:00Z
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() - 10 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });

    // Fill one whole window with reservations whose finalize throws every time.
    // Each needs its own reviewable source: `issues_active_productivity_review_uq`
    // allows at most one active review per (company, originId), and an
    // unreviewable source would be *retired* rather than failed, which drops it
    // out of the window and defeats the point.
    const failingCount = 250;
    const decoyReservedAt = new Date("2026-04-28T11:00:00.000Z"); // d
    const decoySourceIds = Array.from({ length: failingCount }, () => randomUUID());
    const decoyReviewIds = Array.from({ length: failingCount }, () => randomUUID());
    await db.insert(issues).values(
      decoySourceIds.map((id, i) => ({
        id,
        companyId: seeded.companyId,
        title: `Failing source ${i}`,
        status: "in_progress" as const,
        priority: "medium" as const,
        assigneeAgentId: seeded.coderId,
        originKind: "manual",
        issueNumber: 1000 + i,
        identifier: `${seeded.issuePrefix}-${1000 + i}`,
        startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
        monitorNextCheckAt: new Date(now.getTime() - 10 * 60 * 1000),
        monitorScheduledBy: "assignee" as const,
        createdAt: decoyReservedAt,
        updatedAt: decoyReservedAt,
      })),
    );
    await db.insert(issues).values(
      decoyReviewIds.map((id, i) => ({
        id,
        companyId: seeded.companyId,
        title: `Failing reservation ${i}`,
        status: "todo" as const,
        priority: "medium" as const,
        parentId: decoySourceIds[i],
        assigneeAgentId: seeded.managerId,
        createdByAgentId: seeded.coderId,
        originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
        originId: decoySourceIds[i],
        originFingerprint: `productivity-review:${decoySourceIds[i]}`,
        requestDepth: 1,
        // Reserved: no identifier/issueNumber yet, which is what keeps them in
        // `recoverStaleReservedProductivityReviews`' predicate pass after pass.
        issueNumber: null,
        identifier: null,
        createdAt: decoyReservedAt,
        updatedAt: decoyReservedAt,
        lastActivityAt: decoyReservedAt,
      })),
    );

    // The target: `d < n < c_1`, so it is eligible on pass 1 yet sorts behind
    // the whole failing cohort and is cut by the LIMIT.
    const targetReservedAt = new Date("2026-04-28T11:50:00.000Z"); // n
    expect(decoyReservedAt.getTime()).toBeLessThan(targetReservedAt.getTime());
    expect(targetReservedAt.getTime()).toBeLessThan(staleCutoff.getTime());
    const targetId = await insertProductivityReview({ seeded, createdAt: targetReservedAt });

    const failing = new Set(decoyReviewIds);
    let targetFinalizeAttempts = 0;
    const service = productivityReviewService(db, {
      async beforeStaleReservationRecoveryFinalize(review) {
        if (failing.has(review.id)) {
          throw new Error("finalize is deterministically broken for this reservation");
        }
        if (review.id === targetId) targetFinalizeAttempts += 1;
      },
    });
    const reconcileAt = (at: Date) =>
      service.reconcileProductivityReviews({
        now: at,
        companyId: seeded.companyId,
        thresholds: { monitorLapseServiceGraceMs: 60_000 },
      });
    const target = async () =>
      db
        .select()
        .from(issues)
        .where(eq(issues.id, targetId))
        .then((rows) => rows[0]);

    // Pass 1: the window is saturated by the failing cohort, so the target is
    // never even attempted. This is the starved shape, and it is correct here.
    const first = await reconcileAt(now);
    expect(first.failed).toBe(failingCount);
    expect(targetFinalizeAttempts).toBe(0);
    expect((await target())?.identifier).toBeNull();

    // Pass 2: the cohort was backed off to pass 1's `now`, so it no longer
    // satisfies `updatedAt < staleCutoff` and vacates the window entirely; the
    // target is the only candidate left. Pre-fix the cohort is still at
    // `decoyReservedAt` and this stays red forever, at any number of passes.
    const second = await reconcileAt(new Date(now.getTime() + 1_000));
    expect(targetFinalizeAttempts).toBe(1);
    const recovered = await target();
    // Finalized — identifier/issueNumber allocated is exactly what "recovered"
    // means here, and is the inverse of the reserved state asserted above. The
    // number itself is not pinned: the cohort's own sources consume the prefix
    // sequence, so it tracks `failingCount` rather than the source's `-2`.
    expect(recovered?.identifier).not.toBeNull();
    expect(recovered?.issueNumber).not.toBeNull();
    // Nothing of the cohort is even attempted on this pass — the back-off is a
    // hard exclusion, not a re-ordering, so it cannot occupy a single slot.
    expect(second.failed).toBe(0);
    // BLO-22985: 120s, matching the two sibling full-window tests above and
    // below. This one was authored without a cap and inherited the 60s global,
    // which is not enough: it inserts 500 rows and then drives 250 failing
    // finalizes, each with its own back-off UPDATE. Measured 32.5s unloaded
    // (64-core host, load ~10) — only 1.8x under the global, so a merge-queue
    // runner pod at 1.0-1.8 cores runs it straight past the deadline. It did,
    // ejecting #1854 from the master queue on 2026-09-17 (run 35226379587).
    // 120s is 3.7x the measured cost and still catches a genuine hang: the
    // failure this test exists to detect is an unbounded recovery loop, which
    // does not finish at any budget.
  }, 120_000);

  it("replays missing finalized review side effects without duplicating them", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() - 10 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    const reviewId = await insertProductivityReview({
      seeded,
      createdAt,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
    });

    const wakeups: Array<{ agentId: string; opts: unknown }> = [];
    const service = productivityReviewService(db, {
      async enqueueWakeup(agentId, opts) {
        wakeups.push({ agentId, opts });
        return { id: randomUUID() };
      },
    });

    const replayed = await service.reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000, longActiveMs: 60_000 },
    });
    expect(replayed.created).toBe(1);
    expect(replayed.failed).toBe(0);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.opts).toMatchObject({
      idempotencyKey: `productivity-review-created:${reviewId}`,
    });
    expect(await countReviewActivity(reviewId, "issue.productivity_review_created")).toBe(1);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_assignment_wake_enqueued")).toBe(1);

    const second = await service.reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000, longActiveMs: 60_000 },
    });
    expect(second.created).toBe(0);
    expect(second.existing).toBe(1);
    expect(wakeups).toHaveLength(1);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_created")).toBe(1);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_assignment_wake_enqueued")).toBe(1);
  });

  it("retries finalized review assignment wake after a null enqueue result", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() - 10 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    const reviewId = await insertProductivityReview({
      seeded,
      createdAt,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
    });

    const wakeups: Array<{ agentId: string; opts: unknown }> = [];
    let enqueueAttempts = 0;
    const service = productivityReviewService(db, {
      async enqueueWakeup(agentId, opts) {
        wakeups.push({ agentId, opts });
        enqueueAttempts += 1;
        if (enqueueAttempts === 2) {
          await db
            .update(activityLog)
            .set({ createdAt: now })
            .where(
              and(
                eq(activityLog.companyId, seeded.companyId),
                eq(activityLog.entityType, "issue"),
                eq(activityLog.entityId, reviewId),
                inArray(activityLog.action, [
                  "issue.productivity_review_assignment_wake_started",
                  "issue.productivity_review_assignment_wake_failed",
                ]),
              ),
            );
        }
        return enqueueAttempts === 1 ? null : { id: randomUUID() };
      },
    });

    const first = await service.reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000, longActiveMs: 60_000 },
    });
    expect(first.created).toBe(1);
    expect(wakeups).toHaveLength(1);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_created")).toBe(1);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_assignment_wake_enqueued")).toBe(0);

    const second = await service.reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000, longActiveMs: 60_000 },
    });
    expect(second.created).toBe(1);
    expect(wakeups).toHaveLength(2);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_created")).toBe(1);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_assignment_wake_enqueued")).toBe(1);
  });

  it("does not treat a fresh assignment wake claim as expired after a long scan", async () => {
    const scanStartedAt = new Date(Date.now() - 10 * 60_000);
    const createdAt = new Date(scanStartedAt.getTime() - 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(scanStartedAt.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(scanStartedAt.getTime() - 10 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    const reviewId = await insertProductivityReview({
      seeded,
      createdAt,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
    });

    const wakeups: Array<{ agentId: string; opts: unknown }> = [];
    const firstWakeStarted = deferred();
    const releaseFirstWake = deferred();
    const service = productivityReviewService(db, {
      async enqueueWakeup(agentId, opts) {
        wakeups.push({ agentId, opts });
        if (wakeups.length === 1) {
          firstWakeStarted.resolve();
          await releaseFirstWake.promise;
        }
        return { id: randomUUID() };
      },
    });

    const first = service.reconcileProductivityReviews({
      now: scanStartedAt,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000, longActiveMs: 60_000 },
    });
    await firstWakeStarted.promise;

    const second = await service.reconcileProductivityReviews({
      now: scanStartedAt,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000, longActiveMs: 60_000 },
    });

    expect(second.created).toBe(0);
    expect(second.existing).toBe(1);
    expect(wakeups).toHaveLength(1);
    releaseFirstWake.resolve();
    await first;
    expect(await countReviewActivity(reviewId, "issue.productivity_review_assignment_wake_enqueued")).toBe(1);
  });

  it("treats a completed assignment wake request as durable delivery evidence", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() - 10 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    const reviewId = await insertProductivityReview({
      seeded,
      createdAt,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
    });
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: reviewId,
      agentId: seeded.managerId,
      details: {
        source: "productivity_review.reconcile",
        sourceIssueId: seeded.issueId,
        trigger: "long_active_duration",
      },
      createdAt,
    });
    await db.insert(agentWakeupRequests).values({
      companyId: seeded.companyId,
      agentId: seeded.managerId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      status: "completed",
      idempotencyKey: `productivity-review-created:${reviewId}`,
      requestedByActorType: "system",
      requestedByActorId: "productivity_review",
      requestedAt: createdAt,
      finishedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });

    const wakeups: Array<{ agentId: string; opts: unknown }> = [];
    const service = productivityReviewService(db, {
      async enqueueWakeup(agentId, opts) {
        wakeups.push({ agentId, opts });
        throw new Error("completed wake should be reused");
      },
    });

    const replayed = await service.reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000, longActiveMs: 60_000 },
    });
    expect(replayed.created).toBe(1);
    expect(wakeups).toHaveLength(0);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_created")).toBe(1);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_assignment_wake_enqueued")).toBe(1);
  });

  it("does not hold the review row lock while enqueueing assignment wake", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() - 10 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    const reviewId = await insertProductivityReview({
      seeded,
      createdAt,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
    });

    const service = productivityReviewService(db, {
      async enqueueWakeup() {
        await db.transaction(async (tx) => {
          await tx.execute(sql`
            select ${issues.id}
            from ${issues}
            where ${issues.id} = ${reviewId}
            for update
          `);
        });
        return { id: randomUUID() };
      },
    });

    await expect(
      withTimeout(
        service.reconcileProductivityReviews({
          now,
          companyId: seeded.companyId,
          thresholds: { monitorLapseServiceGraceMs: 60_000, longActiveMs: 60_000 },
        }),
        // Hang guard, not a latency budget: this catches the enqueue blocking
        // forever on the row lock it takes below. Happy path is tens of ms; the
        // old 1_000 tripped under merge-queue shard contention (BLO-22985, 3x).
        // 15s stays well under the 60s vitest testTimeout so the labelled error
        // still beats the generic timeout, which is why the guard exists.
        15_000,
        "productivity review wake enqueue row-lock replay",
      ),
    ).resolves.toMatchObject({ created: 1 });
    expect(await countReviewActivity(reviewId, "issue.productivity_review_assignment_wake_enqueued")).toBe(1);
  });

  it("retires a stale reserved review after its source becomes terminal", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const reservedAt = new Date(now.getTime() - 10 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() - 10 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    const reviewId = await insertProductivityReview({ seeded, createdAt: reservedAt });
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(now.getTime() - 60_000), updatedAt: now })
      .where(eq(issues.id, seeded.issueId));

    const wakeups: Array<{ agentId: string; opts: unknown }> = [];
    const result = await productivityReviewService(db, {
      async enqueueWakeup(agentId, opts) {
        wakeups.push({ agentId, opts });
        return { id: randomUUID() };
      },
    }).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000 },
    });

    expect(result.scanned).toBe(0);
    expect(result.created).toBe(0);
    expect(result.closedTerminalSourceReviews).toBe(1);
    const [review] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, reviewId));
    expect(review).toMatchObject({ status: "done", identifier: null, issueNumber: null });
    expect(wakeups).toHaveLength(0);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_created")).toBe(0);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_assignment_wake_enqueued")).toBe(0);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_suppressed_open_review_closed")).toBe(1);
  });

  it("retires a stale reserved review after its source leaves candidate status", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const reservedAt = new Date(now.getTime() - 10 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() - 10 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    const reviewId = await insertProductivityReview({ seeded, createdAt: reservedAt });
    await db
      .update(issues)
      .set({ status: "in_review", updatedAt: now })
      .where(eq(issues.id, seeded.issueId));

    const wakeups: Array<{ agentId: string; opts: unknown }> = [];
    const result = await productivityReviewService(db, {
      async enqueueWakeup(agentId, opts) {
        wakeups.push({ agentId, opts });
        return { id: randomUUID() };
      },
    }).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000 },
    });

    expect(result.created).toBe(0);
    expect(result.closedTerminalSourceReviews).toBe(1);
    const [review] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, reviewId));
    expect(review).toMatchObject({ status: "done", identifier: null, issueNumber: null });
    expect(wakeups).toHaveLength(0);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_created")).toBe(0);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_assignment_wake_enqueued")).toBe(0);
    const [closed] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, reviewId), eq(activityLog.action, "issue.productivity_review_suppressed_open_review_closed")));
    expect(closed?.details).toMatchObject({ suppressedBy: "unreviewable_source", sourceStatus: "in_review" });
  });

  it("retires a stale reserved review after its source review owner changes", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const reservedAt = new Date(now.getTime() - 10 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() - 10 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    const reviewId = await insertProductivityReview({ seeded, createdAt: reservedAt });
    const newManagerId = randomUUID();
    const newCoderId = randomUUID();
    await db.insert(agents).values([
      {
        id: newManagerId,
        companyId: seeded.companyId,
        name: "New CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: newCoderId,
        companyId: seeded.companyId,
        name: "New Coder",
        role: "engineer",
        status: "idle",
        reportsTo: newManagerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db
      .update(issues)
      .set({ assigneeAgentId: newCoderId, updatedAt: now })
      .where(eq(issues.id, seeded.issueId));

    const wakeups: Array<{ agentId: string; opts: unknown }> = [];
    const result = await productivityReviewService(db, {
      async enqueueWakeup(agentId, opts) {
        wakeups.push({ agentId, opts });
        return { id: randomUUID() };
      },
    }).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000 },
    });

    expect(result.created).toBe(0);
    expect(result.closedTerminalSourceReviews).toBe(1);
    const [review] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, reviewId));
    expect(review).toMatchObject({ status: "done", identifier: null, issueNumber: null });
    expect(wakeups).toHaveLength(0);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_created")).toBe(0);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_assignment_wake_enqueued")).toBe(0);
    const [closed] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, reviewId), eq(activityLog.action, "issue.productivity_review_suppressed_open_review_closed")));
    expect(closed?.details).toMatchObject({ suppressedBy: "review_owner_changed" });
  });

  it("retires a stale reserved review after its source is reassigned under the same review owner", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const reservedAt = new Date(now.getTime() - 10 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() - 10 * 60 * 1000),
      monitorScheduledBy: "assignee",
    });
    const reviewId = await insertProductivityReview({ seeded, createdAt: reservedAt });
    const newCoderId = randomUUID();
    await db.insert(agents).values({
      id: newCoderId,
      companyId: seeded.companyId,
      name: "Same Manager Coder",
      role: "engineer",
      status: "idle",
      reportsTo: seeded.managerId,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db
      .update(issues)
      .set({ assigneeAgentId: newCoderId, updatedAt: now })
      .where(eq(issues.id, seeded.issueId));

    const wakeups: Array<{ agentId: string; opts: unknown }> = [];
    const result = await productivityReviewService(db, {
      async enqueueWakeup(agentId, opts) {
        wakeups.push({ agentId, opts });
        return { id: randomUUID() };
      },
    }).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000 },
    });

    expect(result.created).toBe(0);
    expect(result.closedTerminalSourceReviews).toBe(1);
    const [review] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, reviewId));
    expect(review).toMatchObject({ status: "done", identifier: null, issueNumber: null });
    expect(wakeups).toHaveLength(0);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_created")).toBe(0);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_assignment_wake_enqueued")).toBe(0);
    const [closed] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, reviewId), eq(activityLog.action, "issue.productivity_review_suppressed_open_review_closed")));
    expect(closed?.details).toMatchObject({ suppressedBy: "unreviewable_source" });
  });

  it("retires a stale reserved review after its source disappears", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const reservedAt = new Date(now.getTime() - 10 * 60_000);
    const seeded = await seedAssignedIssue({
      status: "done",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    const missingSourceId = randomUUID();
    const reviewId = await insertProductivityReview({ seeded, createdAt: reservedAt });
    await db
      .update(issues)
      .set({
        parentId: null,
        originId: missingSourceId,
        originFingerprint: `productivity-review:${missingSourceId}`,
        updatedAt: reservedAt,
      })
      .where(eq(issues.id, reviewId));

    const wakeups: Array<{ agentId: string; opts: unknown }> = [];
    const result = await productivityReviewService(db, {
      async enqueueWakeup(agentId, opts) {
        wakeups.push({ agentId, opts });
        return { id: randomUUID() };
      },
    }).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 60_000 },
    });

    expect(result.created).toBe(0);
    expect(result.closedTerminalSourceReviews).toBe(1);
    const [review] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, reviewId));
    expect(review).toMatchObject({ status: "done", identifier: null, issueNumber: null });
    expect(wakeups).toHaveLength(0);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_created")).toBe(0);
    expect(await countReviewActivity(reviewId, "issue.productivity_review_assignment_wake_enqueued")).toBe(0);
    const [closed] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, reviewId), eq(activityLog.action, "issue.productivity_review_suppressed_open_review_closed")));
    expect(closed?.details).toMatchObject({
      suppressedBy: "missing_source",
      sourceIssueId: missingSourceId,
      sourceMissing: true,
    });
  });

  // Negative control for BLO-21003: a monitor that lapsed well past the
  // lapse-to-service grace window, with no pending wake, is genuinely
  // unsupervised and must still fire exactly as it does today. Without this
  // case, a fix that simply disabled the trigger (e.g. always suppressing)
  // would pass the positive test above too.
  // BLO-25877: past the service grace window is necessary but not sufficient once
  // `longActive` subtracts the measured monitor-gated span — the monitor here lapses
  // near the *start* of the episode (not 10 minutes before `now`, as this test used
  // to set up) so the genuinely-unattended remainder still clears the default 6h
  // threshold on its own, the same way an 8h-old, never-re-armed lapse would.
  it("still creates a long-active review when the monitor lapsed well past the service grace window", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const startedAt = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt,
      monitorNextCheckAt: new Date(startedAt.getTime() + 5 * 60 * 1000),
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

  // BLO-21003 AC3 / BLO-25877: even outside the suppression window (monitor already
  // lapsed, well past grace), a sub-minute nonzero unattended residue must not floor
  // to `0m` — that reads as "measured and zero" rather than "sub-minute and real".
  // Replays the BLO-19772 shape (14h10m elapsed, wake serviced ~45s after the monitor
  // came due) but reports the residue directly as seconds instead of flooring it
  // away. Uses a non-null, never-triggered `monitorNextCheckAt` (not
  // `monitorLastTriggeredAt`) so this exercises the "lapsed, unserviced" gating branch
  // rather than BLO-25877's just-fired suppression branch, and shrinks both grace and
  // the long-active threshold so a 45s residue is both past grace and past threshold
  // without inflating the episode.
  it("reports a sub-minute unattended residue in seconds instead of flooring it to 0m", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const startedAt = new Date(now.getTime() - (14 * 60 + 10) * 60 * 1000);
    const monitorNextCheckAt = new Date(now.getTime() - 45_000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt,
      monitorNextCheckAt,
      monitorScheduledBy: "assignee",
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { monitorLapseServiceGraceMs: 10_000, longActiveMs: 30_000 },
    });

    expect(result.created).toBe(1);
    expect(result.monitorScheduledSuppressed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain(
      `- Elapsed accounting: 14h 9m monitor-gated, 45s unattended (monitor lapsed at ${monitorNextCheckAt.toISOString()}, never re-armed)`,
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
  //
  // BLO-25877: a null `monitorNextCheckAt` with `monitorLastTriggeredAt` set means
  // the monitor's last transition was a fire, not an abandoned schedule — the text
  // now says so ("fired on schedule ... and enqueued a successor run") rather than
  // "lapsed, never re-armed", which BLO-25877 reserves for a monitor that is
  // actually stuck. No successor run is named here because none was seeded.
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
      `- Elapsed accounting: 1h 23m monitor-gated, 14h 30m unattended (monitor fired on schedule at ${monitorLastTriggeredAt.toISOString()} and enqueued a successor run; nothing has re-armed it since)`,
    );
  });

  // The still-armed branch is the one a manager is most likely to act on: it
  // attributes the entire episode to gating because no column records when the
  // monitor was armed. `monitorScheduledBy: null` reaches it without tripping
  // the deliberate-monitor suppression, so the qualifier itself is pinned —
  // an unqualified "15h monitor-gated, 0m unattended" would tell the manager a
  // real stall was fully accounted for.
  //
  // BLO-27698: this is also the B3a regression guard BLO-27225 calls "the most
  // important single test in the set" — `created: 1` below is what fails if the
  // `!gatedIsUpperBound` condition is ever dropped from the long-active predicate,
  // which would make the trigger structurally unfireable for any issue with a
  // monitor armed however briefly (the indefinite-suppression hazard BLO-22331 AC2
  // forbids). Verified by removing that condition and watching this go red. Named
  // here because the guard was twice reported missing: it asserts the behaviour
  // without mentioning `gatedIsUpperBound`, so a grep for the symbol does not find it.
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

  // BLO-27698 B1: executing time is a third bucket, not a share of "unattended".
  // A run that was demonstrably executing means the assignee had its turn and was
  // taking it — the opposite reader action from "nobody was watching" — so
  // collapsing the two tells an adjudicating manager the wrong thing.
  //
  // Note the fixture shape: `activeStartedAt` is the most recent *dispatch*
  // (`mostRecentDispatchAt`), so a run seeded mid-episode silently redefines the
  // episode to start at itself. The run therefore starts exactly at
  // `issue.startedAt`, which is also the real shape — the current run's live span
  // begins at the episode boundary by construction.
  //
  // 10h episode, monitor lapsed 2h in, run live for the first 3h. Executing is
  // scoped to the unwatched suffix, so only the run's third hour (the part past
  // the lapse) counts: 2h gated + 1h executing + 7h unattended === 10h, the
  // `gatedMs + executingMs + unattendedMs === elapsedMs` invariant in rendered
  // form. The first two executing hours stay inside the gated prefix on purpose —
  // the monitor was accounting for them.
  //
  // Still fires, deliberately: the suppression gate compares
  // `unattendedMs + executingMs` (8h) against the 6h bar, bit-identical to the
  // pre-B1 `unattendedMs` it replaced. Narrowing that to the 7h unattended bucket
  // is B3's job, in its own PR — doing it here would be the compute-without-
  // consult failure BLO-27225 exists to document.
  it("reports executing time as a third elapsed bucket distinct from gated and unattended", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const startedAt = new Date(now.getTime() - 10 * 60 * 60 * 1000);
    const monitorLastTriggeredAt = new Date(startedAt.getTime() + 2 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt,
      monitorNextCheckAt: null,
      monitorScheduledBy: "assignee",
      monitorLastTriggeredAt,
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      status: "succeeded",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 3 * 60 * 60 * 1000),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
      livenessState: "advanced",
      nextAction: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain(
      `- Elapsed accounting: 2h 0m monitor-gated, 1h 0m executing, 7h 0m unattended (monitor fired on schedule at ${monitorLastTriggeredAt.toISOString()} and enqueued a successor run`,
    );
  });

  // The no-monitor branch attributes the whole episode to the unwatched suffix,
  // so the entire live span comes out of it: 0 + 3 + 7 === 10.
  it("carves executing time out of a wholly unattended episode", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const startedAt = new Date(now.getTime() - 10 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      status: "succeeded",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 3 * 60 * 60 * 1000),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
      livenessState: "advanced",
      nextAction: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain(
      "- Elapsed accounting: 0m monitor-gated, 3h 0m executing, 7h 0m unattended (no monitor armed during this episode)",
    );
  });

  // The still-armed branch must be untouched by B1, and this is the guard that
  // pins it. Executing time is carved out of the unwatched suffix only, and that
  // branch has none — the whole episode is the gated prefix — so a live run must
  // leave the line reading exactly as it did before, `unattendedMs` still 0 and
  // `gatedIsUpperBound` still true.
  //
  // Carving the overlap out of the gated prefix instead would shrink `gatedMs`
  // below the episode and break the "≤15h monitor-gated, ≥0m unattended" upper
  // bound the B3a regression guard above depends on — the indefinite-suppression
  // hazard BLO-22331 AC2 forbids, reachable through a bucket change rather than
  // through the predicate.
  it("leaves the still-armed upper-bound split unchanged when a run was executing", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const startedAt = new Date(now.getTime() - 15 * 60 * 60 * 1000);
    const armedUntil = new Date(now.getTime() + 30 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt,
      monitorNextCheckAt: armedUntil,
      monitorScheduledBy: null,
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      status: "succeeded",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 6 * 60 * 60 * 1000),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
      livenessState: "advanced",
      nextAction: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain(
      `- Elapsed accounting: ≤15h 0m monitor-gated, ≥0m unattended (monitor armed until ${armedUntil.toISOString()}`,
    );
    // Scoped to the bucket's rendered form: the prose elsewhere in the report
    // uses the bare word, so a `not.toContain("executing")` would fail on text
    // this change never touches.
    expect(review?.description).not.toContain(" executing,");
  });

  // BLO-27698 B3 — the trigger now reads the *unattended* bucket, not the whole
  // episode. 13h episode, no monitor, a run that executed the first 7h and then
  // finished: 0m gated + 7h executing + 6h unattended. Pre-B3 this fired, because
  // the gate compared `unattendedMs + executingMs` (13h) against the 6h bar. The
  // 6h unattended residue is still at the bar, so this case is NOT suppressed by
  // the unattended arm — it is suppressed by B2's dominance arm, which is what
  // makes this the B2 test rather than a second B3 one.
  //
  // `runaway_execution` cannot rescue it either: that trigger keys on a run still
  // signalling now, and this one is terminal. So `created: 0` here is the whole
  // B2 claim — an episode more than half spent executing is not assignee
  // inactivity — and it is the assertion that fails if the dominance arm is
  // dropped.
  it("suppresses long_active_duration when executing time dominates the episode", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const startedAt = new Date(now.getTime() - 13 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      status: "succeeded",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 7 * 60 * 60 * 1000),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
      livenessState: "advanced",
      nextAction: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  // BLO-27698 B2 boundedness (BLO-22331 AC2) — the same fixture one hour later.
  // The executing span is unchanged at 7h, so at a 14h episode its share is
  // exactly 0.5, the strict `>` in `isDominantEpisodeShare` goes false, and the
  // review fires on 7h of unattended time.
  //
  // This is the guard that the B2 arm cannot become indefinite: it is not gated
  // on any liveness flag, so the only thing that ever clears it is the episode
  // outgrowing twice the executing time. One hour of drift either side of that
  // boundary flips the verdict, which is what "bounded" has to mean here.
  it("fires again once the episode outgrows twice the executing time", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const startedAt = new Date(now.getTime() - 14 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      status: "succeeded",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 7 * 60 * 60 * 1000),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
      livenessState: "advanced",
      nextAction: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
    expect(review?.description).toContain("- Elapsed accounting: 0m monitor-gated, 7h 0m executing, 7h 0m unattended");
  });

  // BLO-27698 B2 boundedness, the case the test above cannot reach (Ally review
  // on fe4e9dcb). Both fixtures above let the episode clock run — they set no
  // `executionRunId`, so `nonLiveExecutionHoldSince` returns null,
  // `attributableEndAt` is `now`, and `elapsedMs` grows every reconcile. That is
  // what makes the share test self-clearing there, and it is exactly the
  // assumption that fails here.
  //
  // A silent `running` HOLDER pins `attributableEndAt` at the fixed
  // `lastSignal + NON_LIVE_EXECUTION_SILENCE_MS`. `elapsedMs`, `executingMs` and
  // `unattendedMs` then freeze, so the ratio is constant across every subsequent
  // reconcile and can never cross back under the bar — indefinite suppression,
  // the BLO-22331 AC2 hazard. Advancing `now` cannot rescue it the way the
  // boundedness test does, because advancing `now` no longer moves the episode.
  //
  // The holder carries NO `startedAt`, which is the documented shape for one
  // (see the `activeStartedAt` comment at productivity-review.ts:3784 — a holder
  // pinned via `executionRunId` tracks liveness through `lastOutputAt` instead).
  // That detail is what makes the case reachable, and the review's own worked
  // example is not: a holder that *does* carry `startedAt` necessarily spans the
  // whole episode, because the anchor is `max(startedAt)` — which is at or after
  // the holder's own start — while the episode END is that same holder's silence
  // point. Unattended collapses to 0 and the first arm suppresses before B2 is
  // ever consulted. Here the executing time comes from a terminal sibling that
  // ran the first 9h, so the two ends are decoupled and the 7h residue is real.
  //
  // 16h episode, 9h executing (9/16 > 0.5, so the dominance arm engages), 7h
  // unattended (above the 6h bar, so the first arm does not). `runaway_execution`
  // declines because the sibling is terminal and no longer signalling.
  it("fires long_active_duration when a dominant executing share is frozen by a non-live holder", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const hours = (n: number) => new Date(now.getTime() - n * 60 * 60 * 1000);
    const holderId = randomUUID();
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: hours(18),
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
    });
    await db.insert(heartbeatRuns).values([
      {
        // The holder: `running`, no `startedAt`, last signal 4h stale. Pins
        // `attributableEndAt` at 2h ago and contributes no live span of its own
        // (`runLiveInterval` returns null without a `startedAt`).
        id: holderId,
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        status: "running",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: null,
        lastOutputAt: hours(4),
        contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
        livenessState: "advanced",
        nextAction: null,
        createdAt: hours(19),
        updatedAt: hours(4),
      },
      {
        // Terminal sibling carrying the executing time. Starts before the issue's
        // own `startedAt` so it cannot pull the anchor forward.
        id: randomUUID(),
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        status: "succeeded",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: hours(19),
        finishedAt: hours(9),
        contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
        livenessState: "advanced",
        nextAction: null,
        createdAt: hours(19),
        updatedAt: hours(9),
      },
    ]);
    await db
      .update(issues)
      .set({ executionRunId: holderId, checkoutRunId: holderId, executionLockedAt: hours(4) })
      .where(eq(issues.id, seeded.issueId));

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    // Anchors the positive: without the `trailingHoldMs === 0` conjunct the
    // dominance arm suppresses this outright and `created` is 0.
    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
    // The frozen figures themselves, so a future change that "fixes" this by
    // moving the episode window rather than bounding the arm also fails here.
    expect(review?.description).toContain("- Elapsed accounting: 0m monitor-gated, 9h 0m executing, 7h 0m unattended");
  });

  // BLO-27698 B3 — the narrowing itself, isolated from B2's dominance arm. 9h
  // episode, no monitor, a run that executed the first 4h and then finished:
  // 0m gated + 4h executing + 5h unattended.
  //
  // Every number here is load-bearing, and the fixture was wrong once before it
  // was right — the first version (13h episode, 4h executing, 1h unattended)
  // asserted `created: 0` and passed with B3 reverted, because 4h + 1h never
  // cleared the 6h bar in the first place. It proved nothing. The control that
  // matters is: restore B1's `unattendedMs + executingMs` addend and this must go
  // red, which requires the sum (9h) above the bar and the unattended component
  // (5h) below it.
  //
  // Executing is 4/9, NOT dominant, so B2's arm cannot be what suppresses this.
  // The run is terminal, so `runaway_execution` cannot rescue it. That leaves the
  // unattended arm as the only possible cause of `created: 0`.
  //
  // `gatedIsUpperBound` is false here (no monitor was ever armed), which is the
  // B3a precondition — the unattended figure is measured, so it is safe to gate
  // on. The still-armed converse, where `unattendedMs: 0` is a deliberate upper
  // bound and generation must STILL occur, is pinned by "marks monitor-gated time
  // as an upper bound while the monitor is still armed" above.
  it("does not fire long_active_duration on executing time once the unattended residue is below the bar", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const startedAt = new Date(now.getTime() - 9 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      status: "succeeded",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 4 * 60 * 60 * 1000),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
      livenessState: "advanced",
      nextAction: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  // BLO-27698 B3b — the case B3 drops, relocated rather than lost. Same 13h
  // episode and the same run, except it is still `running` and still signalling,
  // so its turn never came back. B3 alone would make this silent: executing
  // covers the episode, the unattended residue is ~0, and the trigger that used
  // to catch it now reads only that residue.
  //
  // The assertion is deliberately on the trigger name, not just on `created: 1`.
  // A review that fires as `long_active_duration` here would carry the wrong
  // rubric — its four verdicts all ask what progress the assignee showed while
  // it was NOT working — and the manager's question for a run that is still
  // executing is a different one.
  it("relocates a still-executing runaway run to its own trigger", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const startedAt = new Date(now.getTime() - 13 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      lastOutputAt: new Date(now.getTime() - 60 * 1000),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
      livenessState: "advanced",
      nextAction: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `runaway_execution`");
    expect(review?.description).toContain("a single run has been executing continuously for 13h");
    // The rubric has to move with the trigger, or the relocation is cosmetic.
    expect(review?.description).toContain("this is a runtime/cost question");
    expect(review?.description).not.toContain("A \"Close as productive\" verdict requires");
  });

  // BLO-27698 B3b boundedness — a `running` row is not by itself an executing
  // run. Same fixture with the last signal 3h stale: `runLiveInterval` caps the
  // span at last-signal + NON_LIVE_EXECUTION_SILENCE_MS (2h), so the run is no
  // longer live as of `now` and cannot claim the runaway trigger.
  //
  // Without this the trigger would fire on a wedged holder forever — the run
  // status alone never changes — which is the same indefinite hazard as reading
  // an upper-bound bucket as measured.
  it("does not treat a silent running row as a runaway execution", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const startedAt = new Date(now.getTime() - 13 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      lastOutputAt: new Date(now.getTime() - 3 * 60 * 60 * 1000),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
      livenessState: "advanced",
      nextAction: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description ?? "").not.toContain("Primary trigger: `runaway_execution`");
    // Ally review follow-up: anchor the negative. Asserting only the absence of a
    // trigger name would also pass if review generation broke outright for an
    // unrelated reason, which would make this test stop discriminating silently.
    //
    // Nothing fires here, and that is the B3 + B3b design meeting rather than a
    // gap: `runLiveInterval` caps this run at last-signal + 2h, so ~12h of the
    // 13h episode is still attributed to *executing* — which leaves `unattendedMs`
    // ~1h, below the bar, so B3 declines `long_active_duration` — while the span
    // ends an hour before `now`, so it is not live and B3b declines
    // `runaway_execution`. A wedged-but-silent holder is `no_comment_streak`'s
    // case, not either B-group trigger's.
    expect(result.created).toBe(0);
  });

  // BLO-27698 B3b (Ally review follow-up) — pins the human-gate opt-out that
  // outranking `long_active_duration` creates. Every suppression gate in this
  // file is keyed on `trigger === "long_active_duration"`, so selecting
  // `runaway_execution` bypasses the approval gate, the pending-monitor
  // suppression and the A1 progress-PR gate at once. That is intended — a run
  // burning compute past the bar is not excused by a monitor that says "wake me
  // later" — but it was previously unstated and unpinned: every other runaway
  // fixture sets `monitorNextCheckAt: null`, so nothing would have caught a
  // silent flip in either direction.
  //
  // Fires the trigger *through* an armed future monitor, which is exactly the
  // configuration that suppresses `long_active_duration` in the sibling test
  // below. If someone later decides a monitor should suppress runaway runs,
  // this test must be changed deliberately rather than discovered broken.
  it("fires runaway_execution through an armed monitor that would suppress long_active_duration", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const startedAt = new Date(now.getTime() - 13 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt,
      // Armed, in the future, and never yet fired — the shape
      // `currentPendingMonitorForReviewSuppression` holds a review back on.
      monitorNextCheckAt: new Date(now.getTime() + 60 * 60 * 1000),
      monitorLastTriggeredAt: null,
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      lastOutputAt: new Date(now.getTime() - 60 * 1000),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
      livenessState: "advanced",
      nextAction: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `runaway_execution`");
    // Not merely "a review fired" — it must not have been recorded as a
    // monitor-suppressed review, which is the shape the gate would have produced.
    expect(review?.description).not.toContain("Suppressed by a scheduled monitor");
  });

  // BLO-27698 B3b (Ally review on 7f4fbc43b) — `runaway_execution` is the only
  // trigger in the set whose subject is a single in-flight run, and every option
  // in its rubric ("let it finish", "bound it", "route to platform/SRE") is an
  // instruction to a live process. Its real retirement predicate is therefore
  // *the run ended*; source-`done` is a strictly narrower proxy. Before the
  // `execution_ended` arm, the ordinary shape — run executes past the bar, review
  // fires, run exits, issue stays `in_progress` — stranded an unanswerable review
  // in a manager's queue indefinitely, because generation cannot retire one
  // either (`createOrUpdateReview` returns null the moment no trigger fires, so
  // an open review whose trigger stopped firing is never revisited).
  //
  // The source is deliberately NOT `done` here: that is the pre-existing
  // `terminal_source` arm, and asserting `closedTerminalSourceReviews` is 0 is
  // what stops this passing through it.
  it("retires an open runaway_execution review once its run has stopped executing", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const startedAt = new Date(now.getTime() - 13 * 60 * 60 * 1000);
    const finishedAt = new Date(now.getTime() - 30 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      // Terminal: `runLiveInterval` ends a terminal row at `finishedAt`, which is
      // in the past, so `stillSignalling` is false and `liveExecutingMs` is 0.
      status: "succeeded",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      finishedAt,
      lastOutputAt: finishedAt,
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
      livenessState: "advanced",
      nextAction: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    });
    const reviewId = await insertProductivityReview({ seeded, createdAt: startedAt });
    await logActivity(db, {
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: reviewId,
      details: { trigger: "runaway_execution", sourceIssueId: seeded.issueId },
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.closedExecutionEndedReviews).toBe(1);
    expect(result.closedTerminalSourceReviews).toBe(0);
    expect(result.closedDependencyBlockedReviews).toBe(0);
    expect(result.closedSuppressedMonitorReviews).toBe(0);
    const [review] = await db.select().from(issues).where(eq(issues.id, reviewId));
    expect(review?.status).toBe("done");
    const [closed] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, reviewId),
          eq(activityLog.action, "issue.productivity_review_suppressed_open_review_closed"),
        ),
      );
    // The source status is carried so a reader can see this retired on the run,
    // not on the issue — the distinction the whole arm exists to draw.
    expect(closed?.details).toMatchObject({
      suppressedBy: "execution_ended",
      sourceStatus: "in_progress",
    });
  });

  // The converse, and the more important of the pair: a genuinely runaway run
  // must stay flagged. Identical fixture except the run is still `running` and
  // signalling, which is the only difference the `execution_ended` predicate is
  // allowed to key on. Without this, the arm above could degrade into a blanket
  // retirement of every `runaway_execution` review and the suite would stay green
  // — B3b's own acceptance criterion is that a runaway run stays detectable.
  it("keeps an open runaway_execution review while its run is still executing", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const startedAt = new Date(now.getTime() - 13 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({ status: "in_progress", startedAt });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      // Signalled a minute ago, so `runLiveInterval` caps the span at `now` and
      // `stillSignalling` holds.
      lastOutputAt: new Date(now.getTime() - 60 * 1000),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
      livenessState: "advanced",
      nextAction: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    });
    const reviewId = await insertProductivityReview({ seeded, createdAt: startedAt });
    await logActivity(db, {
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: reviewId,
      details: { trigger: "runaway_execution", sourceIssueId: seeded.issueId },
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.closedExecutionEndedReviews).toBe(0);
    const [review] = await db.select().from(issues).where(eq(issues.id, reviewId));
    expect(review?.status).not.toBe("done");
    expect(
      await countReviewActivity(reviewId, "issue.productivity_review_suppressed_open_review_closed"),
    ).toBe(0);
  });

  // BLO-27698 B3b (Ally review follow-up) — `reconcileProductivityReviews`
  // selects candidates in `["todo", "in_progress"]`, but `elapsedMs` is null for
  // anything not `in_progress`. Without the `elapsedMs !== null` guard,
  // `runaway_execution` keys purely on a live run span and so fires on a `todo`
  // issue that still carries a signalling `running` row — an issue released back
  // to `todo` mid-run, or a checkout that never landed. `long_active_duration`
  // is structurally incapable of producing that report, so this trigger must not
  // introduce it: such a review renders "Current active elapsed time: unknown"
  // with no `Elapsed accounting` line, i.e. it would be evidence-free as well as
  // wrong.
  it("does not fire runaway_execution on a todo issue with a live running row", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const startedAt = new Date(now.getTime() - 13 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "todo",
      startedAt,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      // Signalling as of `now`, so the span IS live — the guard, not staleness,
      // is what has to stop this. Restoring the unguarded predicate turns this red.
      lastOutputAt: new Date(now.getTime() - 60 * 1000),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
      livenessState: "advanced",
      nextAction: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description ?? "").not.toContain("Primary trigger: `runaway_execution`");
    expect(result.created).toBe(0);
  });

  // BLO-27698 B3b (Ally reviews on 2e95b50b and 160720b4) — episode attribution
  // must ask "is anything live on this issue", not "is the *holder* live".
  // `nonLiveExecutionHoldSince` keys only on `issue.executionRunId`, so a parked
  // holder truncates the episode into the past even while another run of the same
  // assignee is still executing on the same issue.
  //
  // The fixture is that exact shape and nothing else: a `queued` holder last
  // signalling 11h ago plus a live sibling that has been `running` for 13h and is
  // still signalling. Holder-only, the episode reads 2h, and *both* `elapsedMs`
  // and `liveExecutingMs` are cut to it — so B2, B3 and B3b were blind to the
  // sibling between them and a 13h runaway produced no review at all. That was
  // the coverage gap B3b's AC forbids ("do not silently drop it").
  //
  // With `siblingStillExecuting` extending `attributableEndAt` to `now`, the two
  // figures move together: 13h executing inside a 13h episode. That is what makes
  // firing safe here — the self-contradictory evidence pack the tail clamp was
  // added to prevent ("executing continuously for 13h" above "Current active
  // elapsed time: 2h") is unrepresentable, so consistency is no longer bought by
  // discarding the burn. Both halves are asserted below; asserting only the
  // trigger would pass on exactly the contradiction this rejects.
  //
  // Mutation control: dropping the `siblingStillExecuting` term from
  // `attributableEndAt` turns this red — the episode collapses to 2h, nothing
  // clears the 6h bar, and `created` falls to 0.
  //
  // BLO-18307 is not weakened. Its shape is a parked holder with *nothing* live,
  // which still truncates exactly as before — see the non-live execution hold
  // tests above, which pin that path independently.
  it("fires runaway_execution on a live sibling while the holder is parked, with a self-consistent episode", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const startedAt = new Date(now.getTime() - 13 * 60 * 60 * 1000);
    // The holder's last signal — `attributableEndAt` if liveness were holder-only.
    const holderLastSignal = new Date(now.getTime() - 11 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
    });
    const siblingId = randomUUID();
    const holderId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        // Live sibling: signalling as of `now`, so its span IS live and only the
        // tail clamp can bound it.
        id: siblingId,
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        status: "running",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt,
        lastOutputAt: new Date(now.getTime() - 60 * 1000),
        contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
        livenessState: "advanced",
        nextAction: null,
        createdAt: startedAt,
        updatedAt: startedAt,
      },
      {
        // Parked holder: `queued` returns `lastSignal` from
        // `nonLiveExecutionHoldSince`, truncating the episode to 11h ago.
        id: holderId,
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        status: "queued",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: null,
        lastOutputAt: holderLastSignal,
        contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
        livenessState: "advanced",
        nextAction: null,
        createdAt: holderLastSignal,
        updatedAt: holderLastSignal,
      },
    ]);
    await db
      .update(issues)
      .set({ executionRunId: holderId, checkoutRunId: holderId, executionLockedAt: holderLastSignal })
      .where(eq(issues.id, seeded.issueId));

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    // Dropping `siblingStillExecuting` from `attributableEndAt` turns this red.
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(result.scanned).toBe(1);
    expect(result.created).toBe(1);
    expect(review?.description ?? "").toContain("Primary trigger: `runaway_execution`");
    // The episode and the burn agree. Holder-only these read 13h and 2h, which is
    // the contradiction the tail clamp was added to suppress; fixing attribution
    // removes it instead.
    expect(review?.description ?? "").toContain("executing continuously for 13h 0m");
    expect(review?.description ?? "").toContain("Current active elapsed time: 13h 0m");
    expect(review?.description ?? "").toContain("13h 0m executing");
  });

  // BLO-27698 B3b (Ally review on 06b87852): the tail extension above must be
  // bounded by the sibling's own live span, not applied as a duration-blind
  // boolean. These two cases pin the two halves of that bound: a sibling whose
  // live segment began *after* the holder parked cannot resurrect the park
  // before it, and the sibling's own burn still counts in full.
  //
  // The reachable shape is a *promoted* sibling, not a freshly dispatched one,
  // and the difference is load-bearing. `activeStartedAt` is `max(startedAt)`
  // over the issue's runs, so a sibling that merely started 10m ago also drags
  // the episode anchor to 10m ago and bounds `elapsedMs` on its own — the
  // review's worked example is not reachable that way. A run promoted out of a
  // park keeps its pre-park `startedAt` (promoteDueScheduledRetry writes only
  // status/error/updatedAt; the claim preserves `startedAt ?? claimedAt`), so
  // the anchor stays at 13h while the live segment is minutes old. That is the
  // gap `runLiveInterval`/`liveSegmentStartedAt` already exclude for the holder,
  // and what `siblingSegmentStart` extends issue-wide.
  //
  // Mutation control for both: drop `siblingSegmentStart` from `segmentStart`
  // and both turn red — the first fires `long_active_duration` reporting 13h of
  // "active elapsed time" for an episode that was 11h of park, and the second
  // re-reports 7h of burn as 13h.
  const seedParkedHolderWithPromotedSibling = async (now: Date, siblingParkEndedAt: Date) => {
    const startedAt = new Date(now.getTime() - 13 * 60 * 60 * 1000);
    // The holder's last signal — `attributableEndAt` if liveness were holder-only.
    const holderLastSignal = new Date(now.getTime() - 11 * 60 * 60 * 1000);
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
    });
    const siblingId = randomUUID();
    const holderId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        // Promoted sibling: `startedAt` is the preserved pre-park dispatch, so it
        // anchors the episode at 13h, while its live span starts at the park
        // boundary. Signalling as of `now`, so it is genuinely live.
        id: siblingId,
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        status: "running",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt,
        scheduledRetryAt: siblingParkEndedAt,
        lastOutputAt: new Date(now.getTime() - 60 * 1000),
        contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
        livenessState: "advanced",
        nextAction: null,
        createdAt: startedAt,
        updatedAt: startedAt,
      },
      {
        // Parked holder, with a `startedAt` so it is not `dispatch_backlog` and
        // not `currentHolderNeverDispatched` — nothing else holds the trigger.
        // `queued` returns `lastSignal` from `nonLiveExecutionHoldSince`.
        id: holderId,
        companyId: seeded.companyId,
        agentId: seeded.coderId,
        status: "queued",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt,
        lastOutputAt: holderLastSignal,
        contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
        livenessState: "advanced",
        nextAction: null,
        createdAt: holderLastSignal,
        updatedAt: holderLastSignal,
      },
    ]);
    await db
      .update(issues)
      .set({ executionRunId: holderId, checkoutRunId: holderId, executionLockedAt: holderLastSignal })
      .where(eq(issues.id, seeded.issueId));
    return seeded;
  };

  it("does not resurrect a holder park when a sibling has only just gone live", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    // 10 minutes of live segment — far short of the 6h bar on its own, but enough
    // to make `siblingStillExecuting` true and so, on a blind boolean, to
    // re-attribute the holder's whole 11h park into `elapsedMs`.
    const seeded = await seedParkedHolderWithPromotedSibling(now, new Date(now.getTime() - 10 * 60 * 1000));

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.scanned).toBe(1);
    expect(result.created).toBe(0);
  });

  it("counts a live sibling's own burn in full without the park before it", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    // 7h of live segment, beginning 4h after the holder parked: over the 6h bar
    // either way, which is what makes this the load-bearing half — it
    // distinguishes "bounded" from "suppressed".
    const seeded = await seedParkedHolderWithPromotedSibling(now, new Date(now.getTime() - 7 * 60 * 60 * 1000));

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    const [review] = await listProductivityReviews(seeded.companyId);
    expect(result.created).toBe(1);
    expect(review?.description ?? "").toContain("Primary trigger: `runaway_execution`");
    expect(review?.description ?? "").toContain("executing continuously for 7h 0m");
    expect(review?.description ?? "").toContain("Current active elapsed time: 7h 0m");
    // The excluded 6h is still disclosed rather than silently dropped — the
    // second half of the defect, where `trailingHoldMs` went to 0 and the line
    // stopped rendering, so the park was neither counted out nor visible as in.
    expect(review?.description ?? "").toContain("Excluded as non-live execution hold: 6h 0m");
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

  it("suppresses long-active reviews for manager-scheduled future monitor waits", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      monitorNextCheckAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      monitorScheduledBy: "manager",
    });
    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.monitorScheduledSuppressed).toBe(1);
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

  // BLO-27698 B3b (Ally review on 2e95b50b) — `runaway_execution` rides the same
  // `done`-retires arm as `long_active_duration`, for the same reason: it is a
  // runtime/cost alarm on a run executing *right now*, so once the source
  // reaches `done` that run has finished and every option in its rubric ("let it
  // finish", "bound it", "route to platform") is a question about a run that no
  // longer exists. Without this the review sits unanswerable in a reviewer's
  // queue forever.
  //
  // Deliberately paired with the sibling above rather than parameterised: the
  // two arms are separate per-trigger decisions, and `cancelled` must still
  // retire neither.
  it("closes an open runaway-execution productivity review once its source issue is done", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "done",
      startedAt: new Date(now.getTime() - 13 * 60 * 60 * 1000),
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
        trigger: "runaway_execution",
        sourceIssueId: seeded.issueId,
      },
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    // Dropping `runaway_execution` from the `done` arm turns this red.
    expect(result.closedTerminalSourceReviews).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.status).toBe("done");

    const closeEntries = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_suppressed_open_review_closed"));
    expect(closeEntries).toHaveLength(1);
    expect(closeEntries[0]?.details).toMatchObject({
      suppressedBy: "terminal_source",
      sourceStatus: "done",
      sourceIssueId: seeded.issueId,
    });
  });

  // BLO-33477: retirement-scan starvation, the same defect BLO-30303 fixed on
  // the source scan. `closeOpenSuppressedReviews` is the only path that can
  // retire an open review, and it only writes to a review it *retires* — a
  // review that is scanned and correctly declined (its alarm still stands) has
  // nothing written back, so its `updatedAt` never advances. Under
  // `asc(updatedAt)` the same oldest-MAX_CANDIDATE_ISSUES declined rows
  // re-occupied the window on every pass forever, and no review sorting behind
  // them could ever be evaluated.
  //
  // As in BLO-30303, the assertion that matters is rotation *across* passes,
  // not reachability on any single one: on pass 1 every row's watermark is
  // still null, so the target legitimately sorts outside the window. What the
  // fix guarantees is that pass 2 reaches it. Pre-fix this is red at any number
  // of passes, which is what distinguishes a rotation key from a cap increase.
  it("retires a review that sorts outside one retirement-scan window (BLO-33477)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "done",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });

    // Fill one whole window with open reviews whose alarm still stands. Their
    // trigger is `no_comment_streak`, which completion never invalidates, so
    // the retirement loop scans them and declines every one — writing nothing
    // back, which is the whole mechanism. Their sources are `done` so the
    // source-candidate scan cannot mint anything new for them and perturb the
    // window. Each needs its own source: `issues_active_productivity_review_uq`
    // allows at most one active review per (company, originId).
    const decoyCount = 250;
    const decoyAt = new Date("2026-04-01T00:00:00.000Z");
    const decoySourceIds = Array.from({ length: decoyCount }, () => randomUUID());
    const decoyReviewIds = Array.from({ length: decoyCount }, () => randomUUID());
    await db.insert(issues).values(
      decoySourceIds.map((id, i) => ({
        id,
        companyId: seeded.companyId,
        title: `Decoy source ${i}`,
        status: "done" as const,
        priority: "medium" as const,
        assigneeAgentId: seeded.coderId,
        originKind: "manual",
        issueNumber: 1000 + i,
        identifier: `${seeded.issuePrefix}-${1000 + i}`,
        createdAt: decoyAt,
        updatedAt: decoyAt,
      })),
    );
    await db.insert(issues).values(
      decoyReviewIds.map((id, i) => ({
        id,
        companyId: seeded.companyId,
        title: `Decoy review ${i}`,
        status: "todo" as const,
        priority: "medium" as const,
        assigneeAgentId: seeded.managerId,
        parentId: decoySourceIds[i],
        originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
        originId: decoySourceIds[i],
        originFingerprint: `productivity-review:${decoySourceIds[i]}`,
        issueNumber: 2000 + i,
        identifier: `${seeded.issuePrefix}-${2000 + i}`,
        // Older than the target on both keys, so the target sorts outside the
        // window under the pre-fix `updatedAt` order *and* under the fixed
        // `coalesce(productivityScannedAt, createdAt)` order on pass 1.
        createdAt: decoyAt,
        updatedAt: decoyAt,
      })),
    );
    await db.insert(activityLog).values(
      decoyReviewIds.map((id, i) => ({
        companyId: seeded.companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.productivity_review_created",
        entityType: "issue",
        entityId: id,
        details: { trigger: "no_comment_streak", sourceIssueId: decoySourceIds[i] },
        createdAt: decoyAt,
      })),
    );

    // The target: newest open review, source already `done`, so it is retirable
    // the moment the scan actually reaches it. `createdAt` must be strictly
    // before `now`: on pass 2 the decoys carry a watermark of exactly `now`, so
    // an equal `createdAt` would tie and then lose the `asc(updatedAt)`
    // tiebreak to them, leaving the target outside the window even post-fix.
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
      createdAt: new Date("2026-04-27T00:00:00.000Z"),
      updatedAt: now,
    });
    await logActivity(db, {
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: reviewId,
      details: { trigger: "long_active_duration", sourceIssueId: seeded.issueId },
    });

    const service = productivityReviewService(db);

    const first = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    // Pass 1 scans a full window and retires nothing — the funnel shape a
    // starved sweep has, and the reason AC4 wants it counted rather than silent.
    expect(first.retirementScanned).toBe(decoyCount);
    expect(first.retirementRetired).toBe(0);
    expect(first.retirementDeclined).toBe(decoyCount);

    const second = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    // Pre-fix pass 2 re-scans the identical 250 decoys and this is 0 forever.
    expect(second.retirementRetired).toBe(1);
    expect(second.closedTerminalSourceReviews).toBe(1);
    const [review] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, reviewId));
    expect(review?.status).toBe("done");
  }, 120_000);

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

  // BLO-27515: the exact BLO-24166 shape. The monitor's declared gate
  // (`pr:blockcast/paperclip#1281:merged`) was satisfied 16 minutes after its
  // last poll, polling had already stopped, and the review then fired at the 6h
  // mark on an issue whose work had landed 2.5 days earlier. The terminal-gate
  // reconciler records the resolution board-side; generation must consume that
  // record and file nothing.
  async function armTerminatedGateMonitor(input: { issueId: string; gateSignals: string[] }) {
    await db
      .update(issues)
      .set({
        monitorNextCheckAt: null,
        monitorScheduledBy: "assignee",
        monitorLastTriggeredAt: new Date("2026-04-28T05:00:00.000Z"),
        monitorAttemptCount: 3,
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
            lastTriggeredAt: "2026-04-28T05:00:00.000Z",
            attemptCount: 3,
            notes: "merged=NO",
            scheduledBy: "assignee",
            gateSignals: input.gateSignals,
            gateSource: "gates",
            convergenceCount: 3,
            clearedAt: null,
            clearReason: null,
          },
        } as never,
      })
      .where(eq(issues.id, input.issueId));
    for (const signal of input.gateSignals) {
      const match = /^pr:([^:]+):[a-z0-9_-]+$/.exec(signal);
      if (!match) continue;
      await db.insert(issueWorkProducts).values({
        companyId: (await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, input.issueId)))[0]!.companyId,
        issueId: input.issueId,
        type: "pull_request",
        provider: "github",
        externalId: match[1],
        title: match[1],
        status: "merged",
        metadata: { source: "github_pull_request_webhook" },
        sourceTrust: {
          preset: "standard",
          disposition: "promoted",
          promotedByActorType: "system",
          promotedByActorId: "github_pull_request_webhook",
        },
      });
    }
  }

  async function recordTerminalGateResolution(input: {
    companyId: string;
    issueId: string;
    gateSignals: string[];
  }) {
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorType: "system",
      idempotencyKey: terminalGateResolutionIdempotencyKey(input.gateSignals),
      body: "Terminal gate resolved (test fixture).",
    });
  }

  it("does not file a long_active_duration review when the terminal gate is already resolved (BLO-27515)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    const gateSignals = ["pr:blockcast/paperclip#1281:merged"];
    await armTerminatedGateMonitor({ issueId: seeded.issueId, gateSignals });
    await recordTerminalGateResolution({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      gateSignals,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    // Countable on its own, like every other suppression: a silenced review that
    // is invisible is the failure mode this whole area keeps relearning.
    expect(result.terminalGateResolvedSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);

    const suppressions = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_suppressed"));
    expect(suppressions).toHaveLength(1);
    expect((suppressions[0]?.details as { suppressedBy?: string })?.suppressedBy)
      .toBe("terminal_gate_resolved");
  });

  it("still files the review when the same monitor gate has NOT been resolved (BLO-27515)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await armTerminatedGateMonitor({
      issueId: seeded.issueId,
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.terminalGateResolvedSuppressed).toBe(0);
    expect(result.created).toBe(1);
  });

  it("does not let a resolution recorded for a different gate set suppress the review (BLO-27515)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await armTerminatedGateMonitor({
      issueId: seeded.issueId,
      gateSignals: ["pr:blockcast/paperclip#1281:merged"],
    });
    // A re-arm on a new gate leaves the old resolution comment behind. It must
    // stop matching, or oversight never resumes.
    await recordTerminalGateResolution({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      gateSignals: ["pr:blockcast/paperclip#1400:merged"],
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.terminalGateResolvedSuppressed).toBe(0);
    expect(result.created).toBe(1);
  });

  it("still files when a non-closable trigger co-fires with long_active_duration under a resolved gate (BLO-27515)", async () => {
    // A resolved gate explains elapsed wall-clock. It does not explain runs that
    // executed and burned cost, so `high_churn` evidence must survive it — the
    // same evasion `isDependencyBlockedClosableTriggerSet` refuses.
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    const gateSignals = ["pr:blockcast/paperclip#1281:merged"];
    await armTerminatedGateMonitor({ issueId: seeded.issueId, gateSignals });
    await recordTerminalGateResolution({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      gateSignals,
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
      withRunComments: true,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.terminalGateResolvedSuppressed).toBe(0);
    expect(result.created).toBe(1);
  });

  it("resumes long-active oversight after the terminal-gate quiet window expires (BLO-27515)", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    const gateSignals = ["pr:blockcast/paperclip#1281:merged"];
    await armTerminatedGateMonitor({ issueId: seeded.issueId, gateSignals });
    await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      authorType: "system",
      idempotencyKey: terminalGateResolutionIdempotencyKey(gateSignals),
      body: "Terminal gate resolved.",
      createdAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.terminalGateResolvedSuppressed).toBe(0);
    expect(result.created).toBe(1);
  });
});
