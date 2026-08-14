import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { __resetMetricsForTest, renderMetrics } from "../services/metrics.js";
import { refreshQueuedRunAgeMetrics } from "../services/queued-run-age-metrics.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("refreshQueuedRunAgeMetrics (BLO-21116)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-queued-run-age-metrics-");
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
      name: "Queued Run Age Co",
      issuePrefix: "QRA",
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

  it("ages a fresh queued run off createdAt when queuedAt was never stamped", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-08-04T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - 600_000);

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "queued",
      contextSnapshot: {},
      createdAt,
      updatedAt: createdAt,
    });

    await refreshQueuedRunAgeMetrics(db, now);
    const { body } = await renderMetrics();
    expect(body).toContain(`paperclip_queued_run_oldest_age_seconds{agent_id="${agentId}"} 600`);
  });

  it("ages a promoted retry off queuedAt, not off its original (much older) createdAt", async () => {
    // Reproduces the exact false-positive Ally flagged on onprem-k8s#2013: a
    // run that spent hours in scheduled_retry backoff before being promoted
    // back to queued must report only its time since promotion, not its full
    // lifetime since createdAt.
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-08-04T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - 12 * 60 * 60 * 1000); // 12h ago
    const queuedAt = new Date(now.getTime() - 90_000); // promoted 90s ago

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "queued",
      contextSnapshot: {},
      createdAt,
      queuedAt,
      updatedAt: queuedAt,
    });

    await refreshQueuedRunAgeMetrics(db, now);
    const { body } = await renderMetrics();
    expect(body).toContain(`paperclip_queued_run_oldest_age_seconds{agent_id="${agentId}"} 90`);
    expect(body).not.toMatch(new RegExp(`agent_id="${agentId}"\\} 43[0-9]{3}`));
  });
});
