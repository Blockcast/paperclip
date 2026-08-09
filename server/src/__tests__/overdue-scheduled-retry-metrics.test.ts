import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { __resetMetricsForTest, renderMetrics } from "../services/metrics.js";
import { refreshOverdueScheduledRetryAgeMetrics } from "../services/queued-run-age-metrics.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("refreshOverdueScheduledRetryAgeMetrics (BLO-22094)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-overdue-scheduled-retry-metrics-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    __resetMetricsForTest();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Overdue Scheduled Retry Co",
      issuePrefix: "OSR",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test Agent",
      role: "engineer",
      status: "running",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("ages an overdue parked retry off scheduledRetryAt, the due time it missed", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-08-07T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - 3_600_000); // 1h ago, irrelevant to this gauge
    const scheduledRetryAt = new Date(now.getTime() - 90_000); // due 90s ago, never promoted

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      contextSnapshot: {},
      createdAt,
      updatedAt: createdAt,
      scheduledRetryAt,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
    });

    await refreshOverdueScheduledRetryAgeMetrics(db, now);
    const { body } = await renderMetrics();
    expect(body).toContain(`paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 90`);
  });

  it("is silent (reads explicit 0) for a parked retry whose due time is still in the future", async () => {
    // A run merely backing off toward a future scheduledRetryAt is working as
    // designed and must not contribute any age -- this gauge only measures
    // overshoot past due time, not time-since-park.
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-08-07T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - 60_000);
    const scheduledRetryAt = new Date(now.getTime() + 300_000); // due in 5 minutes

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      contextSnapshot: {},
      createdAt,
      updatedAt: createdAt,
      scheduledRetryAt,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "ccrotate_capacity",
    });

    await refreshOverdueScheduledRetryAgeMetrics(db, now);
    const { body } = await renderMetrics();
    expect(body).toContain(`paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 0`);
  });

  it("reads an explicit 0, not an absent series, for an agent with no scheduled_retry rows at all", async () => {
    const { agentId } = await insertCompanyAndAgent();

    await refreshOverdueScheduledRetryAgeMetrics(db, new Date("2026-08-07T12:00:00.000Z"));
    const { body } = await renderMetrics();
    expect(body).toContain(`paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 0`);
  });

  it("is silent for a run already promoted back to queued, even though scheduledRetryAt/scheduledRetryAttempt survive the promotion unchanged", async () => {
    // promoteScheduledRetryRun (heartbeat.ts) flips status to "queued" and
    // resets queuedAt, but does NOT clear scheduledRetryAt/scheduledRetryAttempt
    // on the row. This gauge must key off status='scheduled_retry', not off
    // the mere presence of a past scheduledRetryAt, or every promoted run
    // would falsely read as still overdue-parked forever.
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-08-07T12:00:00.000Z");
    const scheduledRetryAt = new Date(now.getTime() - 3_600_000); // due 1h ago
    const queuedAt = new Date(now.getTime() - 5_000); // promoted 5s ago

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "queued",
      contextSnapshot: {},
      createdAt: scheduledRetryAt,
      updatedAt: queuedAt,
      queuedAt,
      scheduledRetryAt,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
    });

    await refreshOverdueScheduledRetryAgeMetrics(db, now);
    const { body } = await renderMetrics();
    expect(body).toContain(`paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 0`);
  });

  it("reports the OLDEST overdue row per agent when several are parked past due", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-08-07T12:00:00.000Z");

    await db.insert(heartbeatRuns).values([
      {
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "scheduled_retry",
        contextSnapshot: {},
        createdAt: new Date(now.getTime() - 10_000),
        updatedAt: new Date(now.getTime() - 10_000),
        scheduledRetryAt: new Date(now.getTime() - 10_000), // due 10s ago
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "transient_failure",
      },
      {
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "scheduled_retry",
        contextSnapshot: {},
        createdAt: new Date(now.getTime() - 7_200_000),
        updatedAt: new Date(now.getTime() - 7_200_000),
        scheduledRetryAt: new Date(now.getTime() - 7_200_000), // due 2h ago -- the oldest
        scheduledRetryAttempt: 3,
        scheduledRetryReason: "ccrotate_capacity",
      },
    ]);

    await refreshOverdueScheduledRetryAgeMetrics(db, now);
    const { body } = await renderMetrics();
    expect(body).toContain(`paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 7200`);
  });

  it("resets a previously-overdue agent back to 0 once its parked row clears (reset-then-set, not a frozen stale value)", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const firstNow = new Date("2026-08-07T12:00:00.000Z");

    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "scheduled_retry",
        contextSnapshot: {},
        createdAt: new Date(firstNow.getTime() - 120_000),
        updatedAt: new Date(firstNow.getTime() - 120_000),
        scheduledRetryAt: new Date(firstNow.getTime() - 120_000),
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "transient_failure",
      })
      .returning();

    await refreshOverdueScheduledRetryAgeMetrics(db, firstNow);
    expect((await renderMetrics()).body).toContain(
      `paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 120`,
    );

    // Promotion: status flips away from scheduled_retry.
    await db
      .update(heartbeatRuns)
      .set({ status: "queued", queuedAt: firstNow, updatedAt: firstNow })
      .where(eq(heartbeatRuns.id, run.id));

    const secondNow = new Date(firstNow.getTime() + 60_000);
    await refreshOverdueScheduledRetryAgeMetrics(db, secondNow);
    expect((await renderMetrics()).body).toContain(
      `paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 0`,
    );
  });
});
