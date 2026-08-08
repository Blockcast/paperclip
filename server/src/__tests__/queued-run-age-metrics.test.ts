import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  QUEUED_RUN_OLDEST_AGE_METRIC,
  __resetMetricsForTest,
  renderMetrics,
} from "../services/metrics.js";
import { refreshQueuedRunAgeMetrics } from "../services/queued-run-age-metrics.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function unavailableDb(): Db {
  return {
    select() {
      throw new Error("database unavailable");
    },
  } as unknown as Db;
}

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

  it("ages a fresh queued run from createdAt", async () => {
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
    expect(body).toContain(`${QUEUED_RUN_OLDEST_AGE_METRIC}{agent_id="${agentId}"} 600`);
  });

  it("ages a promoted retry from queuedAt instead of its original lifetime", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-08-04T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - 12 * 60 * 60 * 1_000);
    const queuedAt = new Date(now.getTime() - 90_000);

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
    expect(body).toContain(`${QUEUED_RUN_OLDEST_AGE_METRIC}{agent_id="${agentId}"} 90`);
    expect(body).not.toMatch(new RegExp(`agent_id="${agentId}"\\} 43[0-9]{3}`));
  });

  it("withdraws stale zero and stale high samples if the refresh query fails", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const now = new Date("2026-08-04T12:00:00.000Z");
    const sample = `${QUEUED_RUN_OLDEST_AGE_METRIC}{agent_id="${agentId}"}`;

    await refreshQueuedRunAgeMetrics(db, now);
    let body = (await renderMetrics()).body;
    expect(body).toContain(`${sample} 0`);

    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "queued",
      contextSnapshot: {},
      createdAt: new Date(now.getTime() - 7_200_000),
      updatedAt: new Date(now.getTime() - 7_200_000),
    });
    await expect(refreshQueuedRunAgeMetrics(unavailableDb(), now)).rejects.toThrow("database unavailable");
    body = (await renderMetrics()).body;
    expect(body).not.toContain(sample);

    await refreshQueuedRunAgeMetrics(db, now);
    body = (await renderMetrics()).body;
    expect(body).toContain(`${sample} 7200`);

    await expect(refreshQueuedRunAgeMetrics(unavailableDb(), now)).rejects.toThrow("database unavailable");
    body = (await renderMetrics()).body;
    expect(body).not.toContain(sample);
  });
});
