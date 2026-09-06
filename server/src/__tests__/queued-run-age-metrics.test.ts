import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  __resetMetricsForTest,
  QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC,
  QUEUED_RUN_OLDEST_AGE_METRIC,
  renderMetrics,
} from "../services/metrics.js";
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
    // The planner regression test inserts 30k rows. A row-by-row delete is
    // quadratic here because heartbeat_runs has a self-reference without a
    // child-key index; this database is private to the file, so truncate the
    // fixture graph instead of making cleanup dominate the test timeout.
    await db.execute(sql`TRUNCATE TABLE heartbeat_runs, agents, companies CASCADE`);
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
    expect(body).toContain(`${QUEUED_RUN_OLDEST_AGE_METRIC}{agent_id="${agentId}"} 600`);
    expect(body).toContain(`${QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC} 1`);
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
    expect(body).toContain(`${QUEUED_RUN_OLDEST_AGE_METRIC}{agent_id="${agentId}"} 90`);
    expect(body).not.toMatch(new RegExp(`agent_id="${agentId}"\\} 43[0-9]{3}`));
  });

  it("marks the age snapshot stale after a refresh failure without publishing a false zero", async () => {
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

    const failingDb = {
      select: () => {
        throw new Error("simulated queued-run metric refresh outage");
      },
    } as unknown as typeof db;
    await expect(refreshQueuedRunAgeMetrics(failingDb, now)).rejects.toThrow("simulated queued-run metric refresh outage");

    const { body } = await renderMetrics();
    expect(body).toContain(`${QUEUED_RUN_OLDEST_AGE_METRIC}{agent_id="${agentId}"} 600`);
    expect(body).toContain(`${QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC} 0`);
  });

  it("keeps the queue-age aggregate off a full heartbeat history scan", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent();
    await db.execute(sql`
      INSERT INTO heartbeat_runs (
        company_id,
        agent_id,
        invocation_source,
        status,
        context_snapshot,
        queued_at,
        created_at,
        updated_at
      )
      SELECT
        ${companyId}::uuid,
        ${agentId}::uuid,
        'assignment',
        CASE WHEN series <= 300 THEN 'queued' ELSE 'succeeded' END,
        '{}'::jsonb,
        CASE WHEN series <= 300 AND series % 2 = 0 THEN now() - (series || ' seconds')::interval ELSE NULL END,
        now() - ((series + 1000) || ' seconds')::interval,
        now()
      FROM generate_series(1, 30000) AS series
    `);
    await db.execute(sql`ANALYZE heartbeat_runs`);

    // PostgreSQL 18 can prefer a skip scan over an older company/status index
    // for this synthetic one-company data set. Remove those competing indexes
    // in this disposable database so the regression proves the dedicated
    // queue-age index independently of planner-version cost heuristics, then
    // restore the schema in finally so a later test cannot inherit the altered
    // planner surface.
    try {
      await db.execute(sql`DROP INDEX IF EXISTS heartbeat_runs_agent_dispatch_idx`);
      await db.execute(sql`DROP INDEX IF EXISTS heartbeat_runs_company_status_last_output_idx`);
      await db.execute(sql`DROP INDEX IF EXISTS heartbeat_runs_company_status_process_started_idx`);

      const rows = await db.execute(sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT agent_id, min(coalesce(queued_at, created_at)) AS oldest_queued_at
        FROM heartbeat_runs
        WHERE status = 'queued'
        GROUP BY agent_id
      `);
      const root = ((rows[0] as { "QUERY PLAN": Array<{ Plan: PlanNode }> })["QUERY PLAN"])[0]?.Plan;
      expect(root).toBeDefined();

      const nodes: PlanNode[] = [];
      const visit = (node: PlanNode | undefined) => {
        if (!node) return;
        nodes.push(node);
        for (const child of node.Plans ?? []) visit(child);
      };
      visit(root);

      const heartbeatScanNodes = nodes.filter((node) => node["Relation Name"] === "heartbeat_runs");
      expect(heartbeatScanNodes).not.toHaveLength(0);
      expect(heartbeatScanNodes.some((node) => node["Node Type"] === "Seq Scan")).toBe(false);
      expect(
        heartbeatScanNodes.some((node) =>
          ["Index Scan", "Index Only Scan", "Bitmap Heap Scan"].includes(String(node["Node Type"])),
        ),
      ).toBe(true);
      expect(nodes.some((node) => node["Index Name"] === "heartbeat_runs_queued_age_idx")).toBe(true);
    } finally {
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS heartbeat_runs_agent_dispatch_idx
        ON heartbeat_runs USING btree (agent_id, status, created_at, id)
        WHERE status IN ('queued', 'scheduled_retry')
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS heartbeat_runs_company_status_last_output_idx
        ON heartbeat_runs USING btree (company_id, status, last_output_at)
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS heartbeat_runs_company_status_process_started_idx
        ON heartbeat_runs USING btree (company_id, status, process_started_at)
      `);
    }
  });
});

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
};
