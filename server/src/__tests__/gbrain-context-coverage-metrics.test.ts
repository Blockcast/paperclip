import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, heartbeatRuns, companies, agents } from "@paperclipai/db";
import {
  GBRAIN_CONTEXT_COVERAGE_RATIO_LAST_HOUR_METRIC,
  GBRAIN_CONTEXT_COVERAGE_REFRESH_SUCCESS_METRIC,
  GBRAIN_CONTEXT_RUNS_LAST_HOUR_METRIC,
  GBRAIN_CONTEXT_STATE_ROWS_LAST_HOUR_METRIC,
  __resetMetricsForTest,
  renderMetrics,
} from "../services/metrics.js";
import { refreshGbrainContextCoverageMetrics } from "../services/gbrain-context-coverage-metrics.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("refreshGbrainContextCoverageMetrics (BLO-30067)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-gbrain-context-coverage-");
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

  it("materializes zero plugin rows when heartbeat activity exists", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-08-25T12:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Gbrain Coverage Co",
      issuePrefix: "GCC",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coverage Agent",
      role: "engineer",
      status: "running",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date(now.getTime() - 5 * 60 * 1000),
      finishedAt: now,
      contextSnapshot: {},
    });

    await refreshGbrainContextCoverageMetrics(db, now);
    const { body } = await renderMetrics();

    expect(body).toContain(`${GBRAIN_CONTEXT_RUNS_LAST_HOUR_METRIC} 1`);
    expect(body).toContain(`${GBRAIN_CONTEXT_STATE_ROWS_LAST_HOUR_METRIC} 0`);
    expect(body).toContain(`${GBRAIN_CONTEXT_COVERAGE_RATIO_LAST_HOUR_METRIC} 0`);
    expect(body).toContain(`${GBRAIN_CONTEXT_COVERAGE_REFRESH_SUCCESS_METRIC} 1`);
  });
});
