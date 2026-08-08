import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  heartbeatService,
  shouldQueueFollowupInsteadOfAbsorbingIntoRunningRun,
} from "../services/heartbeat.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres PR-review request coalescing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const allowPenstockGate = {
  checkAdapter: async () => ({ allow: true as const }),
  _resetForTesting: () => {},
};

const TASK_KEY = "pr_review:Blockcast/pim-multicast-gateway:1888";

// Shape produced by githubWebhookRoutes' reviewer wake (see
// buildPrReviewerTaskKey + githubContextMetadata in routes/github-webhook.ts).
const reviewerSnapshot = (overrides: Record<string, unknown> = {}) => ({
  taskKey: TASK_KEY,
  wakeReason: "github_pr_review_requested",
  wakeSource: "automation",
  githubPrNumber: 1888,
  githubRepoFullName: "Blockcast/pim-multicast-gateway",
  githubHeadSha: "73bdc7303847",
  reviewKind: "pr_review",
  prRole: "reviewer",
  ...overrides,
});

describe("explicit PR review requests are not absorbed by an in-flight review (BLO-18953)", () => {
  // The in-situ call site applies zombie filtering to the chosen target, which
  // makes a DB-only `running` row fall through for an unrelated reason. These
  // assert the decision itself, where a running run is genuinely live.
  it("does not absorb a review request into a RUNNING same-PR review run", () => {
    expect(
      shouldQueueFollowupInsteadOfAbsorbingIntoRunningRun({
        hasRunningSameScopeRun: true,
        hasQueuedSameScopeRun: false,
        contextSnapshot: reviewerSnapshot({ githubHeadSha: "newerheadB" }),
        wakeCommentId: null,
      }),
    ).toBe(true);
  });

  it("does not absorb a ready_for_review toggle into a RUNNING same-PR review run", () => {
    expect(
      shouldQueueFollowupInsteadOfAbsorbingIntoRunningRun({
        hasRunningSameScopeRun: true,
        hasQueuedSameScopeRun: false,
        contextSnapshot: reviewerSnapshot({ wakeReason: "github_pr_ready_for_review" }),
        wakeCommentId: null,
      }),
    ).toBe(true);
  });

  it("still absorbs a review request when a QUEUED same-PR run exists", () => {
    // The queued run has not started and reads head when it does, so absorbing
    // is correct — this is the rapid-event coalescing we must not regress.
    expect(
      shouldQueueFollowupInsteadOfAbsorbingIntoRunningRun({
        hasRunningSameScopeRun: true,
        hasQueuedSameScopeRun: true,
        contextSnapshot: reviewerSnapshot({ githubHeadSha: "newerheadB" }),
        wakeCommentId: null,
      }),
    ).toBe(false);
  });

  it("queues push (synchronize) wakes behind a running same-PR review run", () => {
    // A running reviewer already snapshotted the old head, so the first push
    // that lands while it runs needs a queued follow-up for the new head.
    // Rapid push bursts still coalesce into that queued follow-up.
    expect(
      shouldQueueFollowupInsteadOfAbsorbingIntoRunningRun({
        hasRunningSameScopeRun: true,
        hasQueuedSameScopeRun: false,
        contextSnapshot: reviewerSnapshot({ wakeReason: "github_pr_synchronized" }),
        wakeCommentId: null,
      }),
    ).toBe(true);
  });

  it("queues an issue-derived new-head request behind a running same-PR review run", () => {
    expect(
      shouldQueueFollowupInsteadOfAbsorbingIntoRunningRun({
        hasRunningSameScopeRun: true,
        hasQueuedSameScopeRun: false,
        contextSnapshot: reviewerSnapshot({ wakeReason: "issue_pr_review_requested" }),
        wakeCommentId: null,
      }),
    ).toBe(true);
  });

  it("does not apply to the PR author's wake, only the reviewer's", () => {
    // The author wake carries the same wakeReason but prRole: "author"; it is
    // issue-scoped and must keep its existing coalescing behavior.
    expect(
      shouldQueueFollowupInsteadOfAbsorbingIntoRunningRun({
        hasRunningSameScopeRun: true,
        hasQueuedSameScopeRun: false,
        contextSnapshot: reviewerSnapshot({ prRole: "author", reviewKind: null }),
        wakeCommentId: null,
      }),
    ).toBe(false);
  });
});

describeEmbeddedPostgres("PR review request coalescing into a queued run", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-pr-review-request-coalescing-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("coalesces into a queued same-PR review run and still writes the coalesced audit row", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const existingRunId = randomUUID();
    const existingWakeupId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Reviewer Co",
      status: "active",
      issuePrefix: "REV",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review Blockcast/pim-multicast-gateway PR #1888",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "pr_review",
      originFingerprint: TASK_KEY,
    });

    await db.insert(agentWakeupRequests).values({
      id: existingWakeupId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_review_requested",
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "github_webhook",
    });
    await db.insert(heartbeatRuns).values({
      id: existingRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: existingWakeupId,
      contextTaskKey: TASK_KEY,
      contextSnapshot: reviewerSnapshot({ githubHeadSha: "olderheadA" }),
    });

    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowPenstockGate,
      skipQueuedRunDispatch: true,
    });

    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: {
        id: issueId,
        assigneeAgentId: agentId,
        status: "todo",
        originKind: "pr_review",
        originFingerprint: TASK_KEY,
      },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: "system",
      requestedByActorId: "github_webhook",
    });

    // No run fan-out: the queued run absorbs the request.
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(existingRunId);

    // The audit row survives, so BLO-18859's counters can report `coalesced`
    // as its own delivery state rather than as a delivered wake.
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.map((wakeup) => wakeup.status).sort()).toEqual(["coalesced", "queued"]);
    expect(wakeups.find((wakeup) => wakeup.status === "coalesced")?.runId).toBe(existingRunId);
  });

  it("queues an issue-derived request after a running reviewer has snapshotted an older head", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runningRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Running Reviewer Co",
      status: "active",
      issuePrefix: "RUN",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review Blockcast/pim-multicast-gateway PR #1888 at newerheadB",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "pr_review",
      originFingerprint: TASK_KEY,
    });
    await db.insert(heartbeatRuns).values({
      id: runningRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      contextTaskKey: TASK_KEY,
      contextSnapshot: reviewerSnapshot({ githubHeadSha: "olderheadA" }),
    });

    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowPenstockGate,
      skipQueuedRunDispatch: true,
    });
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: {
        id: issueId,
        assigneeAgentId: agentId,
        status: "todo",
        originKind: "pr_review",
        originFingerprint: TASK_KEY,
      },
      reason: "issue_assigned",
      mutation: "create_deduplicated",
      contextSource: "issue.create",
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    expect(runs.find((run) => run.id === runningRunId)?.status).toBe("running");
    const followup = runs.find((run) => run.id !== runningRunId);
    expect(followup).toMatchObject({
      status: "queued",
      contextTaskKey: TASK_KEY,
      contextSnapshot: expect.objectContaining({
        wakeReason: "issue_pr_review_requested",
        reviewKind: "pr_review",
        prRole: "reviewer",
        githubPrNumber: 1888,
        githubRepoFullName: "Blockcast/pim-multicast-gateway",
      }),
    });
  });
});
