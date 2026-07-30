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
} from "@paperclipai/db";
import {
  heartbeatService,
  shouldQueueFollowupInsteadOfAbsorbingIntoRunningRun,
} from "../services/heartbeat.js";
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

  it("leaves push (synchronize) wakes coalescing into a running run as before", () => {
    // github_pr_synchronized is deduped upstream by a stable repo+pr+reason
    // idempotency key; forcing a follow-up here would fan out one run per push.
    expect(
      shouldQueueFollowupInsteadOfAbsorbingIntoRunningRun({
        hasRunningSameScopeRun: true,
        hasQueuedSameScopeRun: false,
        contextSnapshot: reviewerSnapshot({ wakeReason: "github_pr_synchronized" }),
        wakeCommentId: null,
      }),
    ).toBe(false);
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

    await db.insert(companies).values({
      id: companyId,
      name: "Reviewer Co",
      status: "active",
      issuePrefix: "REV",
      requireBoardApprovalForNewAgents: false,
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

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_review_requested",
      requestedByActorType: "system",
      requestedByActorId: "github_webhook",
      payload: { taskKey: TASK_KEY, reviewKind: "pr_review" },
      contextSnapshot: reviewerSnapshot({ githubHeadSha: "newerheadB" }),
    });

    // No run fan-out: the queued run absorbs the request.
    expect(run?.id).toBe(existingRunId);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);

    // The audit row survives, so BLO-18859's counters can report `coalesced`
    // as its own delivery state rather than as a delivered wake.
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.map((wakeup) => wakeup.status).sort()).toEqual(["coalesced", "queued"]);
    expect(wakeups.find((wakeup) => wakeup.status === "coalesced")?.runId).toBe(existingRunId);
  });
});
