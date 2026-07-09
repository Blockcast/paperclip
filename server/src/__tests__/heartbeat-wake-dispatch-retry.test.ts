// BLO-14395: webhook-triggered wakes (github-webhook.ts) call heartbeat.wakeup()
// synchronously and always 200 the delivery back to GitHub regardless of the
// dispatch outcome, so GitHub never redelivers on our behalf. Before this fix,
// any exception out of enqueueWakeup for a webhook wake was logged and dropped
// forever with no retry and no durable record -- a transient hiccup silently
// ate a review request (or any other webhook-driven wake) with nothing left to
// investigate or recover. These tests cover the two halves of the fix:
//   - wakeupWithDispatchRetry: business-rule HttpErrors (already durably
//     logged via writeSkippedRequest) pass straight through with no added
//     retry delay and no `dispatch_failed` record; only a genuinely
//     unexpected (non-HttpError) failure gets retried and, on exhaustion,
//     durably recorded.
//   - reconcileFailedWakeDispatches: the periodic sweep that retries
//     `dispatch_failed` rows, recovering them once the underlying condition
//     clears, or marking them `dispatch_superseded` if a retry now resolves
//     into a business-rule outcome instead.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake-dispatch-retry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat wake dispatch retry (BLO-14395)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-wake-dispatch-retry-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(opts?: { agentStatus?: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix: "BLO",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: opts?.agentStatus ?? "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("still enqueues normally on the happy path (no behavior change when nothing fails)", async () => {
    const { agentId } = await seedCompanyAndAgent();
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_opened",
      payload: { taskKey: "pr_review:Blockcast/test#1" },
    });
    expect(run).not.toBeNull();

    const dispatchFailedRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "dispatch_failed")));
    expect(dispatchFailedRows).toHaveLength(0);
  });

  it("passes a business-rule HttpError straight through with no retry delay and no durable dispatch_failed record", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentStatus: "paused" });

    const startedAt = Date.now();
    await expect(
      heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "github_pr_opened",
      }),
    ).rejects.toMatchObject({ status: 409 });
    const elapsedMs = Date.now() - startedAt;
    // The bounded in-process retry backoff is 300ms + 1200ms; a paused-agent
    // conflict must bypass it entirely (HttpErrors are never retried).
    expect(elapsedMs).toBeLessThan(1000);

    const dispatchFailedRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "dispatch_failed")));
    expect(dispatchFailedRows).toHaveLength(0);

    // enqueueWakeup's own gate durably records the business-rule skip.
    const skippedRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "skipped")));
    expect(skippedRows.length).toBeGreaterThan(0);
  });

  it("retries a genuinely unexpected (non-HttpError) dispatch failure and persists a durable dispatch_failed record on exhaustion", async () => {
    const { agentId } = await seedCompanyAndAgent();

    // A circular payload cannot be JSON-serialized by the underlying pg
    // driver -- a deterministic, non-HttpError failure deep inside
    // enqueueWakeup's insert, standing in for a transient DB hiccup.
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "github_pr_review_requested",
        payload: circular,
      }),
    ).rejects.toThrow();

    const dispatchFailedRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "dispatch_failed")));
    expect(dispatchFailedRows).toHaveLength(1);
    const row = dispatchFailedRows[0]!;
    expect(row.reason).toBe("github_pr_review_requested");
    const dispatchRetry = (row.payload as Record<string, unknown>).dispatchRetry as Record<string, unknown>;
    expect(dispatchRetry.attempts).toBe(0);
    expect(typeof dispatchRetry.nextAttemptAt).toBe("string");
    expect(dispatchRetry.originalOpts).toMatchObject({ reason: "github_pr_review_requested" });
  });

  it("reconcileFailedWakeDispatches recovers a dispatch_failed row once the underlying condition clears", async () => {
    const { agentId } = await seedCompanyAndAgent();
    const wakeupRequestId = randomUUID();
    const now = new Date();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!.companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_opened",
      payload: {
        dispatchRetry: {
          attempts: 1,
          nextAttemptAt: new Date(now.getTime() - 1000).toISOString(),
          originalOpts: {
            source: "automation",
            triggerDetail: "system",
            reason: "github_pr_opened",
            payload: { taskKey: "pr_review:Blockcast/test#42" },
          },
        },
      },
      status: "dispatch_failed",
    });

    const result = await heartbeat.reconcileFailedWakeDispatches(now);
    expect(result.recovered).toBe(1);

    const [updated] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    expect(updated?.status).toBe("dispatch_recovered");

    const queuedRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "queued")));
    expect(queuedRows.length).toBeGreaterThan(0);
  });

  it("reconcileFailedWakeDispatches leaves a not-yet-due row untouched", async () => {
    const { agentId, companyId } = await seedCompanyAndAgent();
    const wakeupRequestId = randomUUID();
    const now = new Date();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_opened",
      payload: {
        dispatchRetry: {
          attempts: 1,
          nextAttemptAt: new Date(now.getTime() + 60_000).toISOString(),
          originalOpts: { source: "automation", triggerDetail: "system", reason: "github_pr_opened" },
        },
      },
      status: "dispatch_failed",
    });

    const result = await heartbeat.reconcileFailedWakeDispatches(now);
    expect(result.recovered).toBe(0);
    expect(result.superseded).toBe(0);
    expect(result.exhausted).toBe(0);
    expect(result.stillFailing).toBe(0);

    const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId));
    expect(row?.status).toBe("dispatch_failed");
  });

  it("reconcileFailedWakeDispatches marks a row dispatch_superseded when the retry now resolves to a business-rule outcome", async () => {
    const { agentId, companyId } = await seedCompanyAndAgent({ agentStatus: "paused" });
    const wakeupRequestId = randomUUID();
    const now = new Date();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_opened",
      payload: {
        dispatchRetry: {
          attempts: 1,
          nextAttemptAt: new Date(now.getTime() - 1000).toISOString(),
          originalOpts: { source: "automation", triggerDetail: "system", reason: "github_pr_opened" },
        },
      },
      status: "dispatch_failed",
    });

    const result = await heartbeat.reconcileFailedWakeDispatches(now);
    expect(result.superseded).toBe(1);

    const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId));
    expect(row?.status).toBe("dispatch_superseded");
  });
});
