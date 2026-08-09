import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { __resetMetricsForTest, renderMetrics } from "../services/metrics.js";
import { refreshOverdueScheduledRetryAgeMetrics } from "../services/overdue-scheduled-retry-metrics.js";

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
      issuePrefix: `OSR${companyId.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
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

  it("ages an overdue parked retry from the scheduled due time", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-08-07T12:00:00.000Z");
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      contextSnapshot: {},
      createdAt: new Date(now.getTime() - 3_600_000),
      updatedAt: new Date(now.getTime() - 3_600_000),
      scheduledRetryAt: new Date(now.getTime() - 90_000),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
    });

    await refreshOverdueScheduledRetryAgeMetrics(db, now);
    expect((await renderMetrics()).body).toContain(
      `paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 90`,
    );
  });

  it("writes explicit zeroes for future retries and agents without parked retries", async () => {
    const future = await insertCompanyAndAgent();
    const idle = await insertCompanyAndAgent();
    const now = new Date("2026-08-07T12:00:00.000Z");
    await db.insert(heartbeatRuns).values({
      companyId: future.companyId,
      agentId: future.agentId,
      invocationSource: "assignment",
      status: "scheduled_retry",
      contextSnapshot: {},
      createdAt: now,
      updatedAt: now,
      scheduledRetryAt: new Date(now.getTime() + 300_000),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "ccrotate_capacity",
    });

    await refreshOverdueScheduledRetryAgeMetrics(db, now);
    const { body } = await renderMetrics();
    expect(body).toContain(`paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${future.agentId}"} 0`);
    expect(body).toContain(`paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${idle.agentId}"} 0`);
  });

  it("excludes a promoted retry and resets its prior overdue value to zero", async () => {
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

    await db
      .update(heartbeatRuns)
      .set({ status: "queued", updatedAt: firstNow })
      .where(eq(heartbeatRuns.id, run.id));

    await refreshOverdueScheduledRetryAgeMetrics(db, new Date(firstNow.getTime() + 60_000));
    expect((await renderMetrics()).body).toContain(
      `paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 0`,
    );
  });

  it("reports the oldest overdue retry per agent", async () => {
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
        scheduledRetryAt: new Date(now.getTime() - 10_000),
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
        scheduledRetryAt: new Date(now.getTime() - 7_200_000),
        scheduledRetryAttempt: 3,
        scheduledRetryReason: "ccrotate_capacity",
      },
    ]);

    await refreshOverdueScheduledRetryAgeMetrics(db, now);
    expect((await renderMetrics()).body).toContain(
      `paperclip_overdue_scheduled_retry_oldest_age_seconds{agent_id="${agentId}"} 7200`,
    );
  });
});
