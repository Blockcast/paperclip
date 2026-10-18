import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issueRelations, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  __resetMetricsForTest,
  QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC,
  QUEUED_RUN_OLDEST_AGE_METRIC,
  QUEUED_RUN_OLDEST_CLAIMABLE_AGE_METRIC,
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
    await db.execute(sql`TRUNCATE TABLE heartbeat_runs, issue_relations, issues, agents, companies CASCADE`);
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

  let issueSeq = 0;

  /**
   * Insert an issue, optionally behind an unresolved blocker.
   *
   * A blocker that is NOT `done` is what `listIssueDependencyReadinessMap`
   * reads as unresolved, so this is the real readiness path rather than a
   * stubbed verdict — which matters, because the whole point of PEN-4293 is
   * that the gauge reads the dispatcher's predicate instead of re-deriving one.
   */
  async function insertIssue(
    companyId: string,
    options: { blockedBy?: "open" | "done" } = {},
  ) {
    const issueId = randomUUID();
    issueSeq += 1;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Issue ${issueSeq}`,
      status: options.blockedBy ? "blocked" : "todo",
      issueNumber: issueSeq,
      identifier: `QRA-${issueSeq}`,
    });
    if (options.blockedBy) {
      const blockerId = randomUUID();
      issueSeq += 1;
      await db.insert(issues).values({
        id: blockerId,
        companyId,
        title: `Blocker ${issueSeq}`,
        status: options.blockedBy === "done" ? "done" : "in_progress",
        issueNumber: issueSeq,
        identifier: `QRA-${issueSeq}`,
      });
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerId,
        relatedIssueId: issueId,
        type: "blocks",
      });
    }
    return issueId;
  }

  async function insertQueuedRun(input: {
    companyId: string;
    agentId: string;
    ageSeconds: number;
    now: Date;
    contextSnapshot: Record<string, unknown>;
  }) {
    const createdAt = new Date(input.now.getTime() - input.ageSeconds * 1000);
    await db.insert(heartbeatRuns).values({
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "queued",
      contextSnapshot: input.contextSnapshot,
      createdAt,
      updatedAt: createdAt,
    });
  }

  // PEN-4280/PEN-4293. The dispatcher deliberately refuses to let a
  // dependency-blocked queued run age to the front of the queue
  // (`dispatchRank`/`isDispatchRankReady`, BLO-22091) and `claimQueuedRun`'s
  // cancel-on-blocked screen only fires on a claim that therefore never
  // arrives. So such a run ages without bound while the dispatcher is healthy,
  // and the unfiltered gauge reads that as starvation. Measured 2026-10-18:
  // 21.8x threshold on one seat, four queued runs stacked on one `blocked`
  // issue in 17 minutes.
  describe("claimable-aware gauge (PEN-4293)", () => {
    it("excludes a dependency-blocked queued run while the unfiltered gauge still counts it", async () => {
      const { companyId, agentId } = await insertCompanyAndAgent();
      const now = new Date("2026-10-18T12:00:00.000Z");
      const blockedIssueId = await insertIssue(companyId, { blockedBy: "open" });

      await insertQueuedRun({
        companyId,
        agentId,
        ageSeconds: 7200,
        now,
        contextSnapshot: { issueId: blockedIssueId, wakeReason: "heartbeat_timer" },
      });

      await refreshQueuedRunAgeMetrics(db, now);
      const { body } = await renderMetrics();

      // The unfiltered gauge is deliberately UNCHANGED — a consumer reads it,
      // and the difference between the two is itself the signal.
      expect(body).toContain(`${QUEUED_RUN_OLDEST_AGE_METRIC}{agent_id="${agentId}"} 7200`);
      // This is the assertion the exclusion exists for. Deleting the
      // `isEffectivelyDependencyReadyForDispatch` screen in
      // `refreshClaimableQueuedRunAgeMetrics` makes this line read 7200.
      expect(body).toContain(`${QUEUED_RUN_OLDEST_CLAIMABLE_AGE_METRIC}{agent_id="${agentId}"} 0`);
    });

    it("counts a queued run whose blocker is already done", async () => {
      // The negative control for the test above: if the exclusion were keyed on
      // "the issue has a blocker edge" rather than on readiness, this would be
      // excluded too and the previous test would pass for the wrong reason.
      const { companyId, agentId } = await insertCompanyAndAgent();
      const now = new Date("2026-10-18T12:00:00.000Z");
      const readyIssueId = await insertIssue(companyId, { blockedBy: "done" });

      await insertQueuedRun({
        companyId,
        agentId,
        ageSeconds: 1800,
        now,
        contextSnapshot: { issueId: readyIssueId, wakeReason: "heartbeat_timer" },
      });

      await refreshQueuedRunAgeMetrics(db, now);
      const { body } = await renderMetrics();
      expect(body).toContain(`${QUEUED_RUN_OLDEST_CLAIMABLE_AGE_METRIC}{agent_id="${agentId}"} 1800`);
    });

    it("counts the issue-interaction wake the claim path deliberately exempts", async () => {
      // `claimQueuedRun` lets an issue-interaction wake carrying a comment id
      // run on a blocked issue so a human can talk to the assignee while it
      // waits. That run IS claimable, so excluding it would make this gauge
      // disagree with the claim path — the exact desynchronization
      // `isEffectivelyDependencyReadyForDispatch` exists to prevent. An
      // exclusion written as a bare `isDependencyReady` check fails here.
      const { companyId, agentId } = await insertCompanyAndAgent();
      const now = new Date("2026-10-18T12:00:00.000Z");
      const blockedIssueId = await insertIssue(companyId, { blockedBy: "open" });

      await insertQueuedRun({
        companyId,
        agentId,
        ageSeconds: 900,
        now,
        contextSnapshot: {
          issueId: blockedIssueId,
          wakeReason: "issue_commented",
          wakeCommentId: randomUUID(),
        },
      });

      await refreshQueuedRunAgeMetrics(db, now);
      const { body } = await renderMetrics();
      expect(body).toContain(`${QUEUED_RUN_OLDEST_CLAIMABLE_AGE_METRIC}{agent_id="${agentId}"} 900`);
    });

    it("does not credit an interaction wake that carries no comment id", async () => {
      // The exemption is "interaction wake AND a comment id", not the wake
      // reason alone — a reason-only check would re-open the hole on any run
      // that merely claims to be an interaction wake.
      const { companyId, agentId } = await insertCompanyAndAgent();
      const now = new Date("2026-10-18T12:00:00.000Z");
      const blockedIssueId = await insertIssue(companyId, { blockedBy: "open" });

      await insertQueuedRun({
        companyId,
        agentId,
        ageSeconds: 3600,
        now,
        contextSnapshot: { issueId: blockedIssueId, wakeReason: "issue_commented" },
      });

      await refreshQueuedRunAgeMetrics(db, now);
      const { body } = await renderMetrics();
      expect(body).toContain(`${QUEUED_RUN_OLDEST_CLAIMABLE_AGE_METRIC}{agent_id="${agentId}"} 0`);
    });

    it("reports the oldest CLAIMABLE run, not the oldest run, when both are queued", async () => {
      // The shape that actually fired: undispatchable work at the head of the
      // queue, real work behind it. The unfiltered gauge reports the head's age
      // and reads as starvation; the claimable gauge reports the real wait.
      const { companyId, agentId } = await insertCompanyAndAgent();
      const now = new Date("2026-10-18T12:00:00.000Z");
      const blockedIssueId = await insertIssue(companyId, { blockedBy: "open" });
      const readyIssueId = await insertIssue(companyId);

      await insertQueuedRun({
        companyId,
        agentId,
        ageSeconds: 39_240,
        now,
        contextSnapshot: { issueId: blockedIssueId, wakeReason: "heartbeat_timer" },
      });
      await insertQueuedRun({
        companyId,
        agentId,
        ageSeconds: 120,
        now,
        contextSnapshot: { issueId: readyIssueId, wakeReason: "heartbeat_timer" },
      });

      await refreshQueuedRunAgeMetrics(db, now);
      const { body } = await renderMetrics();
      expect(body).toContain(`${QUEUED_RUN_OLDEST_AGE_METRIC}{agent_id="${agentId}"} 39240`);
      expect(body).toContain(`${QUEUED_RUN_OLDEST_CLAIMABLE_AGE_METRIC}{agent_id="${agentId}"} 120`);
    });

    it("counts a queued run that carries no issue id at all", async () => {
      // The fail-open direction of this change. A run with no issue has no
      // dependency blockers that could make it unclaimable, so dropping it
      // would hide a genuinely stranded run behind a filter never about it.
      const { companyId, agentId } = await insertCompanyAndAgent();
      const now = new Date("2026-10-18T12:00:00.000Z");

      await insertQueuedRun({
        companyId,
        agentId,
        ageSeconds: 450,
        now,
        contextSnapshot: { wakeReason: "heartbeat_timer" },
      });

      await refreshQueuedRunAgeMetrics(db, now);
      const { body } = await renderMetrics();
      expect(body).toContain(`${QUEUED_RUN_OLDEST_CLAIMABLE_AGE_METRIC}{agent_id="${agentId}"} 450`);
    });

    it("emits an explicit 0 for an agent with no queued runs at all", async () => {
      // Absent series and "nothing stuck" render identically on a dashboard —
      // the failure mode BLO-21092 named for a sibling gauge. An agent whose
      // entire queue is unclaimable hits the same floor, so the zero has to be
      // published rather than left out.
      const { agentId } = await insertCompanyAndAgent();
      const now = new Date("2026-10-18T12:00:00.000Z");

      await refreshQueuedRunAgeMetrics(db, now);
      const { body } = await renderMetrics();
      expect(body).toContain(`${QUEUED_RUN_OLDEST_CLAIMABLE_AGE_METRIC}{agent_id="${agentId}"} 0`);
    });

    it("keeps each agent's verdict independent when one agent's queue is entirely blocked", async () => {
      const { companyId, agentId: blockedAgentId } = await insertCompanyAndAgent();
      const healthyAgentId = randomUUID();
      await db.insert(agents).values({
        id: healthyAgentId,
        companyId,
        name: "Healthy Agent",
        role: "engineer",
        status: "running",
        adapterType: "claude_k8s",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      const now = new Date("2026-10-18T12:00:00.000Z");
      const blockedIssueId = await insertIssue(companyId, { blockedBy: "open" });
      const readyIssueId = await insertIssue(companyId);

      await insertQueuedRun({
        companyId,
        agentId: blockedAgentId,
        ageSeconds: 10_000,
        now,
        contextSnapshot: { issueId: blockedIssueId, wakeReason: "heartbeat_timer" },
      });
      await insertQueuedRun({
        companyId,
        agentId: healthyAgentId,
        ageSeconds: 300,
        now,
        contextSnapshot: { issueId: readyIssueId, wakeReason: "heartbeat_timer" },
      });

      await refreshQueuedRunAgeMetrics(db, now);
      const { body } = await renderMetrics();
      expect(body).toContain(`${QUEUED_RUN_OLDEST_CLAIMABLE_AGE_METRIC}{agent_id="${blockedAgentId}"} 0`);
      expect(body).toContain(`${QUEUED_RUN_OLDEST_CLAIMABLE_AGE_METRIC}{agent_id="${healthyAgentId}"} 300`);
    });
  });

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
