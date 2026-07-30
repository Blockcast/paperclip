import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
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
  PR_REVIEW_QUEUE_FAIRNESS_MAX_WAIT_MS,
  selectAgedPrReviewRunForFairDispatch,
} from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres PR-review queue tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("PR-review dispatch fairness", () => {
  const now = new Date("2026-07-14T00:00:00.000Z");
  const queuedRun = (
    id: string,
    ageMs: number,
    contextSnapshot: Record<string, unknown>,
  ) => ({
    id,
    createdAt: new Date(now.getTime() - ageMs),
    contextSnapshot,
  });

  it("promotes the oldest aged review after issue work", () => {
    const selected = selectAgedPrReviewRunForFairDispatch(
      [
        queuedRun("newer-review", 11 * 60 * 1000, {
          taskKey: "pr_review:Blockcast/paperclip:2",
        }),
        queuedRun("oldest-review", 20 * 60 * 1000, {
          taskKey: "pr_review:Blockcast/paperclip:1",
        }),
        queuedRun("issue", 30 * 60 * 1000, { issueId: randomUUID() }),
      ],
      { contextSnapshot: { issueId: randomUUID() } },
      now,
    );

    expect(selected).toBe("oldest-review");
  });

  it("does not promote two reviews consecutively", () => {
    const selected = selectAgedPrReviewRunForFairDispatch(
      [
        queuedRun("review", PR_REVIEW_QUEUE_FAIRNESS_MAX_WAIT_MS + 1, {
          reviewKind: "pr_review",
        }),
      ],
      { contextSnapshot: { taskKey: "pr_review:Blockcast/paperclip:previous" } },
      now,
    );

    expect(selected).toBeNull();
  });

  it("leaves fresh reviews in the normal priority order", () => {
    const selected = selectAgedPrReviewRunForFairDispatch(
      [
        queuedRun("review", PR_REVIEW_QUEUE_FAIRNESS_MAX_WAIT_MS - 1, {
          taskKey: "pr_review:Blockcast/paperclip:1",
        }),
      ],
      { contextSnapshot: { issueId: randomUUID() } },
      now,
    );

    expect(selected).toBeNull();
  });
});

describeEmbeddedPostgres("PR-review wake enqueue concurrency", () => {
  let db!: ReturnType<typeof createDb>;
  let peerDb!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-pr-review-queue-");
    db = createDb(tempDb.connectionString);
    peerDb = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.update(issues).set({ executionRunId: null });
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await peerDb?.$client?.end?.({ timeout: 0 });
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  it("keeps wildcard-like wake prefixes out of bounded PR-review history", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "PR Review Observability Co",
      status: "active",
      issuePrefix: "PRO",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ally",
      role: "reviewer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        finishedAt: new Date("2026-07-25T11:59:00.000Z"),
        contextSnapshot: {
          wakeReason: "githubXprYreview_submitted",
          githubPrNumber: 999,
        },
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        finishedAt: new Date("2026-07-25T11:58:00.000Z"),
        contextSnapshot: {
          reviewKind: "pr_review",
          wakeReason: "github_pr_review_submitted",
          githubPrNumber: 812,
        },
      },
    ]);

    const rows = await db.execute(sql<{ wakeReason: string }>`
      select context_wake_reason as "wakeReason"
      from heartbeat_runs
      where company_id = ${companyId}
        and (
          starts_with(context_wake_reason, 'github_pr_')
          or context_snapshot ->> 'reviewKind' = 'pr_review'
        )
      order by finished_at desc, id desc
      limit 1
    `);

    expect(Array.from(rows)).toEqual([{ wakeReason: "github_pr_review_submitted" }]);
  });

  it("uses the terminal completion-order index for bounded company history", async () => {
    await db.execute(sql`set enable_seqscan = off`);
    const plan = await db.execute(sql<Record<string, string>>`
      explain (costs off)
      select id
      from heartbeat_runs
      where company_id = ${randomUUID()}
        and finished_at >= ${"2026-07-18T00:00:00.000Z"}::timestamptz
      order by finished_at desc, id desc
      limit 201
    `);
    const planText = Array.from(plan).flatMap((row) => Object.values(row)).join("\n");

    expect(planText).toContain("heartbeat_runs_company_finished_at_desc_idx");
  });

  it("coalesces concurrent GitHub issue follow-ups behind a running run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runningRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Review Follow-up Race Co",
      status: "active",
      issuePrefix: "RFR",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "executive",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runningRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: {
        issueId,
        taskId: issueId,
        taskKey: issueId,
        wakeReason: "github_pr_review_submitted",
      },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Harden MCP retention",
      status: "in_progress",
      assigneeAgentId: agentId,
      executionRunId: runningRunId,
      executionAgentNameKey: "cto",
      executionLockedAt: new Date(),
      identifier: "RFR-1",
    });

    const closedHeartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
    const openedHeartbeat = heartbeatService(peerDb, { skipQueuedRunDispatch: true });
    const wake = (reason: "github_pr_closed" | "github_pr_opened", deliveryId: string) => ({
      source: "automation" as const,
      triggerDetail: "system",
      reason,
      payload: { issueId, deliveryId },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        taskKey: issueId,
        wakeReason: reason,
        githubDeliveryId: deliveryId,
      },
      idempotencyKey: `${issueId}:${reason}:${deliveryId}`,
    });

    await Promise.all([
      closedHeartbeat.wakeup(agentId, wake("github_pr_closed", "closed-delivery")),
      openedHeartbeat.wakeup(agentId, wake("github_pr_opened", "opened-delivery")),
    ]);

    const runs = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const wakeups = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(runs.filter((run) => run.status === "running")).toEqual([
      { id: runningRunId, status: "running" },
    ]);
    expect(runs.filter((run) => run.status === "queued")).toHaveLength(1);
    expect(wakeups.filter((wakeRequest) => wakeRequest.status === "queued")).toHaveLength(1);
    expect(wakeups.filter((wakeRequest) => wakeRequest.status === "coalesced")).toHaveLength(1);
  });

  it("coalesces concurrent same-task deliveries into one queued run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "pr_review:Blockcast/penstock-vault-node:189";

    await db.insert(companies).values({
      id: companyId,
      name: "Review Queue Co",
      status: "active",
      issuePrefix: "RQC",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ally",
      role: "reviewer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        heartbeat.wakeup(agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "github_pr_synchronized",
          payload: {
            taskKey,
            deliveryId: `delivery-${index}`,
          },
          contextSnapshot: {
            taskKey,
            reviewKind: "pr_review",
            wakeReason: "github_pr_synchronized",
            githubHeadSha: "aef0402c0eb1bd2d302a4b549390b48672b5e080",
          },
          idempotencyKey: `${taskKey}:github_pr_synchronized`,
        })
      ),
    );

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const wakeups = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("queued");
    expect(new Set(results.map((run) => run?.id))).toEqual(new Set([runs[0]?.id]));
    expect(wakeups.filter((wake) => wake.status === "queued")).toHaveLength(1);
    expect(wakeups.filter((wake) => wake.status === "coalesced")).toHaveLength(11);
  });

  // BLO-18953: the wake used here is a push (github_pr_synchronized), NOT an
  // explicit review request. A push is genuinely covered by a review run that
  // is about to read head, so merging into it is correct. Explicit review
  // requests take the opposite branch — see the sibling test below.
  it("coalesces a push wake when a same-task run starts while enqueue waits for the agent lock", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runningRunId = randomUUID();
    const taskKey = "pr_review:Blockcast/penstock-llm-proxy-core:691";

    await db.insert(companies).values({
      id: companyId,
      name: "Review Running Race Co",
      status: "active",
      issuePrefix: "RRN",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ally",
      role: "reviewer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    let announceRunLock!: () => void;
    let releaseRunLock!: () => void;
    const runLockHeld = new Promise<void>((resolve) => {
      announceRunLock = resolve;
    });
    const runMayCommit = new Promise<void>((resolve) => {
      releaseRunLock = resolve;
    });

    const inFlightRun = db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from agents where id = ${agentId} and company_id = ${companyId} for update`,
      );
      announceRunLock();
      await runMayCommit;

      await tx.insert(heartbeatRuns).values({
        id: runningRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        startedAt: new Date(),
        contextSnapshot: {
          taskKey,
          reviewKind: "pr_review",
          wakeReason: "github_pr_ready_for_review",
          githubRepoFullName: "Blockcast/penstock-llm-proxy-core",
          githubPrNumber: 691,
          githubHeadSha: "d75ddd3322c4599a09233a909aa05905ae9571da",
        },
      });
    });

    await runLockHeld;
    const heartbeat = heartbeatService(peerDb, { skipQueuedRunDispatch: true });
    const enqueue = heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_synchronized",
      payload: { taskKey, deliveryId: "push-delivery" },
      contextSnapshot: {
        taskKey,
        reviewKind: "pr_review",
        wakeReason: "github_pr_synchronized",
        githubRepoFullName: "Blockcast/penstock-llm-proxy-core",
        githubPrNumber: 691,
      },
      idempotencyKey: `${taskKey}:github_pr_synchronized`,
    });

    const lockWaitDeadline = Date.now() + 10_000;
    let enqueueIsWaitingForLock = false;
    while (Date.now() < lockWaitDeadline) {
      const waitingRows = await db.execute(sql<{ waiting: boolean }>`
        select exists (
          select 1
          from pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()
            and wait_event_type = 'Lock'
            and query ~* 'select id from agents.*for update'
        ) as waiting
      `);
      if (Array.from(waitingRows)[0]?.waiting) {
        enqueueIsWaitingForLock = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(enqueueIsWaitingForLock).toBe(true);

    releaseRunLock();
    await inFlightRun;
    const result = await enqueue;

    const runs = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toEqual([{ id: runningRunId, status: "running" }]);
    expect(result?.id).toBe(runningRunId);

    const wakeups = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toEqual([{ status: "coalesced", runId: runningRunId }]);
  });

  // BLO-18953: the lossy half of the same race. A review already in flight
  // against an older head never re-reads head, so absorbing an explicit review
  // request into it drops the request rather than deferring it. Observed live
  // on Blockcast/pim-multicast-gateway#1888 and Blockcast/paperclip#822.
  it("gives an explicit review request its own run when a same-task run starts while enqueue waits for the agent lock", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runningRunId = randomUUID();
    const taskKey = "pr_review:Blockcast/pim-multicast-gateway:1888";

    await db.insert(companies).values({
      id: companyId,
      name: "Review Request Race Co",
      status: "active",
      issuePrefix: "RRQ",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ally",
      role: "reviewer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    let announceRunLock!: () => void;
    let releaseRunLock!: () => void;
    const runLockHeld = new Promise<void>((resolve) => {
      announceRunLock = resolve;
    });
    const runMayCommit = new Promise<void>((resolve) => {
      releaseRunLock = resolve;
    });

    const inFlightRun = db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from agents where id = ${agentId} and company_id = ${companyId} for update`,
      );
      announceRunLock();
      await runMayCommit;

      await tx.insert(heartbeatRuns).values({
        id: runningRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        startedAt: new Date(),
        contextSnapshot: {
          taskKey,
          reviewKind: "pr_review",
          prRole: "reviewer",
          wakeReason: "github_pr_review_requested",
          githubRepoFullName: "Blockcast/pim-multicast-gateway",
          githubPrNumber: 1888,
          githubHeadSha: "403b3d73eb9b",
        },
      });
    });

    await runLockHeld;
    const heartbeat = heartbeatService(peerDb, { skipQueuedRunDispatch: true });
    const enqueue = heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_review_requested",
      payload: { taskKey, deliveryId: "review-request-delivery" },
      contextSnapshot: {
        taskKey,
        reviewKind: "pr_review",
        prRole: "reviewer",
        wakeReason: "github_pr_review_requested",
        githubRepoFullName: "Blockcast/pim-multicast-gateway",
        githubPrNumber: 1888,
        githubHeadSha: "73bdc7303847",
      },
      idempotencyKey: `${taskKey}:github_pr_review_requested:comment:1`,
    });

    const lockWaitDeadline = Date.now() + 10_000;
    let enqueueIsWaitingForLock = false;
    while (Date.now() < lockWaitDeadline) {
      const waitingRows = await db.execute(sql<{ waiting: boolean }>`
        select exists (
          select 1
          from pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()
            and wait_event_type = 'Lock'
            and query ~* 'select id from agents.*for update'
        ) as waiting
      `);
      if (Array.from(waitingRows)[0]?.waiting) {
        enqueueIsWaitingForLock = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(enqueueIsWaitingForLock).toBe(true);

    releaseRunLock();
    await inFlightRun;
    const result = await enqueue;

    const runs = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    // The in-flight run survives untouched; the request gets its own queued run
    // that will read the newer head when it starts.
    expect(runs).toHaveLength(2);
    expect(runs.find((run) => run.id === runningRunId)?.status).toBe("running");
    expect(result?.id).not.toBe(runningRunId);
    expect(runs.find((run) => run.id === result?.id)?.status).toBe("queued");

    const wakeups = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toEqual([{ status: "queued", runId: result?.id }]);
  });

  it("coalesces with a scheduled retry created while the enqueue waits for the agent lock", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const scheduledRunId = randomUUID();
    const taskKey = "pr_review:Blockcast/penstock-vault-node:191";

    await db.insert(companies).values({
      id: companyId,
      name: "Review Retry Race Co",
      status: "active",
      issuePrefix: "RRR",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ally",
      role: "reviewer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    let announceRetryLock!: () => void;
    let releaseRetryLock!: () => void;
    const retryLockHeld = new Promise<void>((resolve) => {
      announceRetryLock = resolve;
    });
    const retryMayCommit = new Promise<void>((resolve) => {
      releaseRetryLock = resolve;
    });

    const inFlightRetry = db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from agents where id = ${agentId} and company_id = ${companyId} for update`,
      );
      announceRetryLock();
      await retryMayCommit;

      await tx.insert(heartbeatRuns).values({
        id: scheduledRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "scheduled_retry",
        scheduledRetryAt: new Date(Date.now() + 5 * 60 * 1000),
        scheduledRetryReason: "ccrotate_capacity",
        contextSnapshot: {
          taskKey,
          reviewKind: "pr_review",
          wakeReason: "github_pr_synchronized",
          githubHeadSha: "old-head",
        },
      });
    });

    await retryLockHeld;
    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
    const enqueue = heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_review_requested",
      payload: { taskKey, deliveryId: "review-request-delivery" },
      contextSnapshot: {
        taskKey,
        reviewKind: "pr_review",
        wakeReason: "github_pr_review_requested",
        githubHeadSha: "new-head",
      },
      idempotencyKey: `${taskKey}:github_pr_review_requested`,
    });

    const outcomeBeforeCommit = await Promise.race([
      enqueue.then(() => "enqueued" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    releaseRetryLock();
    expect(outcomeBeforeCommit).toBe("blocked");

    await inFlightRetry;
    const result = await enqueue;
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const wakeups = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(scheduledRunId);
    expect(runs[0]?.status).toBe("scheduled_retry");
    expect(runs[0]?.contextSnapshot).toMatchObject({
      wakeReason: "github_pr_review_requested",
      githubHeadSha: "new-head",
    });
    expect(result?.id).toBe(scheduledRunId);
    expect(wakeups.filter((wake) => wake.status === "coalesced")).toHaveLength(1);
  });

  it("waits for in-flight pending work before retiring a closed PR task scope", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const wakeupId = randomUUID();
    const runId = randomUUID();
    const scheduledRunId = randomUUID();
    const taskKey = "pr_review:Blockcast/penstock-vault-node:190";

    await db.insert(companies).values({
      id: companyId,
      name: "Review Close Race Co",
      status: "active",
      issuePrefix: "RCR",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ally",
      role: "reviewer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    let announceEnqueueLock!: () => void;
    let releaseEnqueueLock!: () => void;
    const enqueueLockHeld = new Promise<void>((resolve) => {
      announceEnqueueLock = resolve;
    });
    const enqueueMayCommit = new Promise<void>((resolve) => {
      releaseEnqueueLock = resolve;
    });

    const inFlightEnqueue = db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from agents where id = ${agentId} and company_id = ${companyId} for update`,
      );
      announceEnqueueLock();
      await enqueueMayCommit;

      await tx.insert(agentWakeupRequests).values({
        id: wakeupId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "github_pr_synchronized",
        status: "queued",
        runId,
      });
      await tx.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeupId,
        contextSnapshot: {
          taskKey,
          reviewKind: "pr_review",
          wakeReason: "github_pr_synchronized",
        },
      });
      await tx.insert(heartbeatRuns).values({
        id: scheduledRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "scheduled_retry",
        scheduledRetryAt: new Date(Date.now() + 5 * 60 * 1000),
        scheduledRetryReason: "ccrotate_capacity",
        contextSnapshot: {
          taskKey,
          reviewKind: "pr_review",
          wakeReason: "github_pr_synchronized",
        },
      });
    });

    await enqueueLockHeld;
    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
    const cancellation = heartbeat.cancelPendingRunsForTask(
      agentId,
      taskKey,
      "PR closed during enqueue",
    );

    const outcomeBeforeCommit = await Promise.race([
      cancellation.then(() => "cancelled" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    releaseEnqueueLock();
    expect(outcomeBeforeCommit).toBe("blocked");

    await inFlightEnqueue;
    await expect(cancellation).resolves.toBe(2);

    const retiredRuns = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const [wakeup] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupId));
    expect(retiredRuns).toHaveLength(2);
    expect(retiredRuns.every((run) => run.status === "cancelled")).toBe(true);
    expect(wakeup?.status).toBe("cancelled");
  });
});
